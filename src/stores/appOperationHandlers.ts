import { executeNoteAction } from "./actionProcessingStore";
import { useSettingsStore } from "./settingsStore";
import { useMeetingRecordingStore, startRecording, stopRecording } from "./meetingRecordingStore";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import type { ActionItem } from "../types/electron";

/**
 * Renderer half of the main → renderer operation bridge (see
 * src/helpers/appOperations/rendererBridge.js).
 *
 * Operations that genuinely need the UI process dispatch here: they reuse the
 * renderer's own services (settings store, the note-action executor, the
 * meeting-recording store) so an agent-triggered run behaves exactly like the
 * equivalent click. Anything that can run in the main process must NOT be
 * implemented here.
 */

type AppOperationHandler = (
  payload: Record<string, unknown>
) => Promise<unknown> | unknown;

/** Never hand raw secrets to an agent surface. */
const SECRET_KEY_PATTERN = /(apikey|api_key|token|secret|password|privatekey)/i;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key.replace(/[^a-z0-9_]/gi, ""));
}

function redact(settings: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (isSecretKey(key)) {
      out[key] = value ? "<redacted>" : "";
      continue;
    }
    out[key] = value;
  }
  return out;
}

function settingsSnapshot(): Record<string, unknown> {
  const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (typeof value === "function") continue;
    out[key] = value;
  }
  return redact(out);
}

async function findAction(actionId: number): Promise<ActionItem> {
  const actions = (await window.electronAPI?.getActions?.()) ?? [];
  const action = actions.find((item) => item.id === actionId);
  if (!action) throw new Error(`Action ${actionId} not found`);
  return action;
}

/** Mirror of ControlPanel's retry payload: the renderer owns transcription config. */
function transcriptionSettings() {
  const s = useSettingsStore.getState();
  return {
    useLocalWhisper: s.useLocalWhisper,
    localTranscriptionProvider: s.localTranscriptionProvider,
    cloudTranscriptionMode: s.cloudTranscriptionMode,
    cloudTranscriptionProvider: s.cloudTranscriptionProvider,
    cloudTranscriptionModel: s.cloudTranscriptionModel,
    cloudTranscriptionBaseUrl: s.cloudTranscriptionBaseUrl,
    parakeetModel: s.parakeetModel,
    funasrModel: s.funasrModel,
    whisperModel: s.whisperModel,
    customDictionary: s.customDictionary,
    customDictionaryAliases: s.customDictionaryAliases,
    preferredLanguage: s.preferredLanguage,
    transcriptionMode: s.transcriptionMode,
    remoteTranscriptionType: s.remoteTranscriptionType,
    remoteTranscriptionUrl: s.remoteTranscriptionUrl,
  };
}

function coerceSettingValue(current: unknown, raw: unknown): unknown {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string") return raw;
  if (typeof current === "boolean") {
    const text = raw.toLowerCase();
    if (["true", "1", "yes", "on"].includes(text)) return true;
    if (["false", "0", "no", "off"].includes(text)) return false;
    throw new Error(`Setting expects a boolean, got "${raw}"`);
  }
  if (typeof current === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`Setting expects a number, got "${raw}"`);
    return parsed;
  }
  return raw;
}

const handlers: Record<string, AppOperationHandler> = {
  run_note_action: async (payload) => {
    const actionId = Number(payload?.actionId);
    const noteId = Number(payload?.noteId);
    if (!Number.isFinite(actionId) || !Number.isFinite(noteId)) {
      throw new Error("run_note_action requires actionId and noteId");
    }
    const action = await findAction(actionId);
    return executeNoteAction({ noteId, action, trigger: "tool" });
  },

  "settings.get": (payload) => {
    const snapshot = settingsSnapshot();
    const key = typeof payload?.key === "string" && payload.key ? payload.key : null;
    if (!key) return { settings: snapshot, count: Object.keys(snapshot).length };
    if (!(key in snapshot)) throw new Error(`Unknown setting "${key}"`);
    return { key, value: snapshot[key] };
  },

  "settings.set": (payload) => {
    const key = typeof payload?.key === "string" ? payload.key.trim() : "";
    if (!key) throw new Error("A setting key is required");
    if (isSecretKey(key)) {
      throw new Error(
        `"${key}" holds a credential and can only be changed in the app's settings UI`
      );
    }
    const store = useSettingsStore.getState() as unknown as Record<string, unknown>;
    if (!(key in store)) throw new Error(`Unknown setting "${key}"`);

    let value: unknown;
    if (typeof payload?.json === "string" && payload.json) {
      try {
        value = JSON.parse(payload.json);
      } catch (error) {
        throw new Error(`"json" must be valid JSON: ${(error as Error).message}`);
      }
    } else {
      value = coerceSettingValue(store[key], payload?.value);
    }
    if (value === undefined) throw new Error("Provide either `value` or `json`");

    const setterName = `set${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    const setter = store[setterName];
    if (typeof setter === "function") {
      (setter as (next: unknown) => void)(value);
      return { key, applied: "setter" };
    }
    // No dedicated setter: write through the store + localStorage, matching how
    // the store hydrates on startup.
    useSettingsStore.setState({ [key]: value } as never);
    try {
      window.localStorage.setItem(key, typeof value === "string" ? value : JSON.stringify(value));
    } catch {
      // localStorage may be unavailable; the in-memory update still applies.
    }
    return { key, applied: "state" };
  },

  "transcriptions.retry": async (payload) => {
    const id = Number(payload?.id);
    if (!Number.isFinite(id)) throw new Error("transcriptions.retry requires an id");
    const result = await window.electronAPI.retryTranscription(id, transcriptionSettings());
    if (!result?.success) throw new Error(result?.error ?? "Retry failed");
    return result;
  },

  "notes.export_selection": async (payload) => {
    const ids = Array.isArray(payload?.note_ids)
      ? (payload?.note_ids as unknown[]).map(Number).filter((value) => Number.isFinite(value))
      : [];
    if (ids.length === 0) throw new Error("note_ids must contain at least one note id");
    const requestedFormat = typeof payload?.format === "string" ? payload.format : "md";
    const format = (["md", "txt", "pdf"] as const).includes(
      requestedFormat as "md" | "txt" | "pdf"
    )
      ? (requestedFormat as "md" | "txt" | "pdf")
      : "md";
    const allowedFields = ["transcript", "content", "enhanced_content"] as const;
    const requestedFields = Array.isArray(payload?.fields) ? payload.fields.map(String) : [];
    const fields = allowedFields.filter((field) => requestedFields.includes(field));
    const result = await window.electronAPI.exportSelectedNotes(ids, {
      fields: fields.length > 0 ? fields : ["content"],
      format,
    });
    if (!result?.success) throw new Error(result?.error ?? "Export failed");
    return result;
  },

  "recording.status": () => {
    const state = useMeetingRecordingStore.getState();
    return {
      isRecording: state.isRecording,
      noteId: state.recordingNoteId ?? null,
      startedAt: state.recordingStartedAt ?? null,
    };
  },

  "recording.start": async (payload) => {
    const noteId = Number(payload?.note_id);
    if (!Number.isFinite(noteId)) throw new Error("recording.start requires note_id");
    const state = useMeetingRecordingStore.getState();
    if (state.isRecording) {
      throw new Error("A recording is already in progress");
    }
    const note = await window.electronAPI.getNote(noteId);
    if (!note) throw new Error(`Note ${noteId} not found`);
    const seedSegments = note.transcript
      ? parseTranscriptSegments(note.transcript, {
          timelineDurationSeconds: note.audio_duration_seconds ?? null,
        })
      : [];
    await startRecording({
      noteId,
      noteTitle: note.title ?? null,
      folderId: note.folder_id ?? null,
      seedSegments,
      diarizationEnabled:
        note.diarization_enabled == null ? null : note.diarization_enabled === 1,
      expectedCount: note.expected_speaker_count ?? null,
    });
    return { started: true, noteId };
  },

  "recording.stop": async () => {
    const state = useMeetingRecordingStore.getState();
    if (!state.isRecording) throw new Error("No recording is in progress");
    return stopRecording();
  },
};

interface AppOperationMessage {
  id?: string;
  channel?: string;
  payload?: Record<string, unknown>;
}

/** Installs the bridge listener; returns an unsubscribe function. */
export function registerAppOperationHandlers(): () => void {
  const api = window.electronAPI;
  if (!api?.onAppOperationRequest) return () => {};

  return api.onAppOperationRequest((message: AppOperationMessage) => {
    const { id, channel } = message ?? {};
    if (!id || !channel) return;
    const respond = (result: unknown) => {
      api.respondAppOperation?.({ id, ok: true, result });
    };
    const fail = (error: unknown) => {
      api.respondAppOperation?.({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    };

    const handler = handlers[channel];
    if (!handler) {
      fail(new Error(`No renderer handler for app operation "${channel}"`));
      return;
    }

    // Handlers may be async; never let a rejection escape as an unhandled one.
    void Promise.resolve()
      .then(() => handler(message.payload ?? {}))
      .then(respond)
      .catch(fail);
  });
}

export { handlers as appOperationHandlers };
