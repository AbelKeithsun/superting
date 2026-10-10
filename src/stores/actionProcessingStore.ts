import { create } from "zustand";
import i18n from "../i18n";
import type { ActionItem } from "../types/electron";
import { type ActionOutputTarget, validateActionUpdateResult } from "./actionProcessingCore";
import { loadNoteActionSnapshot } from "./noteActionContext";
import { loggableText, logNoteAction, makeNoteActionOperationId } from "./noteActionLogger";
import { runNoteActionOnce } from "./runNoteActionOnce";
import {
  clearNoteAiOperation,
  finishActionOperation,
  startActionOperation,
  updateActionStream,
} from "./noteAiOperationStore";
import {
  selectIsCloudNoteFormattingMode,
  selectResolvedNoteFormatting,
  useSettingsStore,
} from "./settingsStore";

export type ActionProcessingStatus = "idle" | "processing" | "success";

export interface NoteActionState {
  status: ActionProcessingStatus;
  actionName: string | null;
  outputTarget: ActionOutputTarget | null;
}

export interface ActionErrorEvent {
  noteId: number;
  message: string;
}

interface ActionProcessingStoreState {
  noteStates: Record<number, NoteActionState>;
  errorEvents: ActionErrorEvent[];
}

const cancelledFlags = new Map<number, boolean>();
const processingFlags = new Map<number, boolean>();
const successTimers = new Map<number, NodeJS.Timeout>();

const IDLE_STATE: NoteActionState = { status: "idle", actionName: null, outputTarget: null };

function setNoteState(noteId: number, patch: Partial<NoteActionState>) {
  const { noteStates } = useActionProcessingStore.getState();
  const prev = noteStates[noteId] ?? IDLE_STATE;
  useActionProcessingStore.setState({
    noteStates: { ...noteStates, [noteId]: { ...prev, ...patch } },
  });
}

function clearNoteState(noteId: number) {
  const { noteStates } = useActionProcessingStore.getState();
  const next = { ...noteStates };
  delete next[noteId];
  useActionProcessingStore.setState({ noteStates: next });
}

function pushErrorEvent(event: ActionErrorEvent) {
  const { errorEvents } = useActionProcessingStore.getState();
  useActionProcessingStore.setState({ errorEvents: [...errorEvents, event] });
}

export const useActionProcessingStore = create<ActionProcessingStoreState>()(() => ({
  noteStates: {},
  errorEvents: [],
}));

/** Which UI entry point started the run — logging only. */
export type NoteActionTrigger = "toolbar" | "chat" | "tool";

export interface ExecuteNoteActionInput {
  noteId: number;
  action: ActionItem;
  trigger: NoteActionTrigger;
  operationId?: string;
}

export type ExecuteNoteActionResult =
  | { status: "success"; updates: Record<string, string | null> }
  | { status: "error"; message: string }
  | { status: "busy" }
  | { status: "cancelled" };

function actionErrorLabels() {
  return {
    noModel: i18n.t("notes.actions.errors.noModel"),
    actionFailed: i18n.t("notes.actions.errors.actionFailed"),
    noteNotFound: i18n.t("notes.actions.errors.noteNotFound"),
  };
}

function defaultSpeakerLabels() {
  return {
    you: i18n.t("notes.speaker.you"),
    them: i18n.t("notes.speaker.them"),
  };
}

/**
 * The ONE way to run a note action.
 *
 * Both entry points call this: the bottom-bar ActionPicker (through
 * `runBackgroundAction`, fire-and-forget with a toast) and the embedded chat's
 * action strip / `run_note_action` tool (awaited, so the tool row can report the
 * outcome). Everything that used to differ between them lives here now:
 * content snapshot, model resolution, the per-note processing lock, the
 * side-drawer stream, result validation and cancellation.
 */
export async function executeNoteAction({
  noteId,
  action,
  trigger,
  operationId,
}: ExecuteNoteActionInput): Promise<ExecuteNoteActionResult> {
  const effectiveOperationId = operationId ?? makeNoteActionOperationId(noteId, action.id);
  const labels = actionErrorLabels();

  if (processingFlags.get(noteId)) {
    logNoteAction(
      "NOTE_ACTION_SKIPPED_ALREADY_PROCESSING",
      {
        operationId: effectiveOperationId,
        noteId,
        trigger,
        actionId: action.id,
        actionName: action.name,
      },
      "warn"
    );
    return { status: "busy" };
  }

  cancelledFlags.set(noteId, false);
  processingFlags.set(noteId, true);
  const releaseLock = () => processingFlags.set(noteId, false);

  try {
    const settings = useSettingsStore.getState();
    const modelId = selectResolvedNoteFormatting(settings).model;
    const isCloudMode = selectIsCloudNoteFormattingMode(settings);

    if (!modelId && !isCloudMode) {
      logNoteAction(
        "NOTE_ACTION_SKIPPED_NO_MODEL",
        {
          operationId: effectiveOperationId,
          noteId,
          trigger,
          actionId: action.id,
          actionName: action.name,
          isCloudMode,
        },
        "error"
      );
      releaseLock();
      return { status: "error", message: labels.noModel };
    }

    const snapshot = await loadNoteActionSnapshot(noteId);
    if (snapshot.noteMissing) {
      logNoteAction(
        "NOTE_ACTION_SKIPPED_NOTE_MISSING",
        { operationId: effectiveOperationId, noteId, trigger, actionId: action.id },
        "error"
      );
      releaseLock();
      return { status: "error", message: labels.noteNotFound };
    }

    logNoteAction("NOTE_ACTION_SNAPSHOT", {
      operationId: effectiveOperationId,
      noteId,
      trigger,
      actionId: action.id,
      actionName: action.name,
      snapshotSource: snapshot.snapshotSource,
      sources: snapshot.sources,
      isRecording: snapshot.isRecording,
      noteContentLength: String(snapshot.note.content ?? "").length,
      enhancedContentLength: String(snapshot.note.enhanced_content ?? "").length,
      transcriptLength: String(snapshot.note.transcript ?? "").length,
      modelId,
      isCloudMode,
    });

    logNoteAction("NOTE_ACTION_START", {
      operationId: effectiveOperationId,
      noteId,
      trigger,
      actionId: action.id,
      actionName: action.name,
      outputTarget: action.output_target,
      writeMode: action.write_mode,
      modelId,
      isCloudMode,
      snapshotSource: snapshot.snapshotSource,
    });

    setNoteState(noteId, {
      status: "processing",
      actionName: action.name,
      outputTarget: action.output_target === "content" ? "content" : "enhanced_content",
    });
    // Side drawer: show the run (thinking stream + token stats) as it happens.
    startActionOperation(noteId, action.name);

    const { generatedContent, updates } = await runNoteActionOnce({
      noteId,
      note: snapshot.note,
      action,
      modelId,
      isCloudMode,
      operationId: effectiveOperationId,
      onStream: (event) => updateActionStream(noteId, event),
      speakerLabels: defaultSpeakerLabels(),
    });

    if (cancelledFlags.get(noteId)) {
      clearNoteAiOperation(noteId);
      logNoteAction(
        "NOTE_ACTION_CANCELLED_AFTER_MODEL_RESPONSE",
        {
          operationId: effectiveOperationId,
          noteId,
          trigger,
          actionId: action.id,
          actionName: action.name,
          generatedContent: loggableText(generatedContent),
          updates,
        },
        "warn"
      );
      return { status: "cancelled" };
    }

    logNoteAction("NOTE_ACTION_DB_UPDATE_START", {
      operationId: effectiveOperationId,
      noteId,
      trigger,
      actionId: action.id,
      actionName: action.name,
      generatedContent: loggableText(generatedContent),
      updates,
    });
    const updateResult = await window.electronAPI.updateNote(noteId, updates);
    logNoteAction("NOTE_ACTION_DB_UPDATE_RESPONSE", {
      operationId: effectiveOperationId,
      noteId,
      trigger,
      actionId: action.id,
      actionName: action.name,
      updateResult,
    });
    validateActionUpdateResult(updateResult, labels.actionFailed);

    setNoteState(noteId, { status: "success", actionName: action.name });
    finishActionOperation(noteId, true);
    logNoteAction("NOTE_ACTION_SUCCESS", {
      operationId: effectiveOperationId,
      noteId,
      trigger,
      actionId: action.id,
      actionName: action.name,
    });

    const timer = setTimeout(() => {
      processingFlags.set(noteId, false);
      clearNoteState(noteId);
      successTimers.delete(noteId);
    }, 600);
    successTimers.set(noteId, timer);

    return { status: "success", updates };
  } catch (err) {
    if (cancelledFlags.get(noteId)) {
      clearNoteAiOperation(noteId);
      logNoteAction(
        "NOTE_ACTION_CANCELLED_AFTER_ERROR",
        {
          operationId: effectiveOperationId,
          noteId,
          trigger,
          actionId: action.id,
          actionName: action.name,
          error: err instanceof Error ? err.message : String(err),
        },
        "warn"
      );
      return { status: "cancelled" };
    }

    releaseLock();
    clearNoteState(noteId);
    const message = err instanceof Error ? err.message : labels.actionFailed;
    finishActionOperation(noteId, false, message);
    logNoteAction(
      "NOTE_ACTION_ERROR",
      {
        operationId: effectiveOperationId,
        noteId,
        trigger,
        actionId: action.id,
        actionName: action.name,
        error: message,
        stack: err instanceof Error ? err.stack : undefined,
      },
      "error"
    );
    return { status: "error", message };
  } finally {
    cancelledFlags.delete(noteId);
  }
}

/**
 * Start an action from the note toolbar: runs in the background — survives
 * component unmounts and navigation so the user can switch notes mid-action —
 * and surfaces failures as a toast.
 */
export function runBackgroundAction(
  noteId: number,
  action: ActionItem,
  trigger: NoteActionTrigger = "toolbar"
): void {
  void executeNoteAction({ noteId, action, trigger }).then((result) => {
    if (result.status === "error") pushErrorEvent({ noteId, message: result.message });
  });
}

/** Soft cancel: the HTTP request continues but the result is discarded. */
export function cancelAction(noteId: number): void {
  cancelledFlags.set(noteId, true);
  processingFlags.set(noteId, false);
  const timer = successTimers.get(noteId);
  if (timer) {
    clearTimeout(timer);
    successTimers.delete(noteId);
  }
  clearNoteState(noteId);
}

export function consumeErrorEvents(): ActionErrorEvent[] {
  const { errorEvents } = useActionProcessingStore.getState();
  if (errorEvents.length === 0) return [];
  useActionProcessingStore.setState({ errorEvents: [] });
  return errorEvents;
}

export function selectNoteActionState(
  state: ActionProcessingStoreState,
  noteId: number | null
): NoteActionState {
  if (noteId == null) return IDLE_STATE;
  return state.noteStates[noteId] ?? IDLE_STATE;
}
