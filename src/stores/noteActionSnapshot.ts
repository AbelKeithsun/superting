/**
 * Single source of truth for the content a note action runs against.
 *
 * Both entry points (the bottom-bar ActionPicker and the embedded chat's
 * action strip / `run_note_action` tool) funnel through the executor in
 * `actionProcessingStore.ts`, which resolves its snapshot here. Neither entry
 * point may read the note itself any more: the chat path used to re-fetch the
 * note from SQLite, which silently dropped unsaved edits and — while a meeting
 * was being recorded — the entire live transcript.
 *
 * Precedence per field, newest first:
 *   1. `draft`  — the uncommitted edit-session text shown in the editor
 *   2. `memory` — the committed renderer state for the open note
 *   3. `live`   — transcript streamed by the active recording (vs. the DB copy)
 *   4. `db`     — the persisted note (fallback: note not open, or no renderer)
 */

export type NoteActionSnapshotField = "title" | "content" | "enhanced_content" | "transcript";

export type NoteActionFieldSource = "draft" | "memory" | "live" | "db";

export interface NoteActionNote {
  title: string;
  content: string | null;
  enhanced_content: string | null;
  transcript: string | null;
  recorded_at: string | null;
  created_at: string;
  audio_duration_seconds: number | null;
}

/** Renderer state published for the note that is currently open. */
export interface NoteActionLiveContext {
  title?: string | null;
  content?: string | null;
  enhancedContent?: string | null;
  /** Transcript already resolved by the caller (live stream preferred). */
  transcript?: string | null;
  /** True when `transcript` comes from the in-flight recording, not the DB. */
  transcriptIsLive?: boolean;
  /** Uncommitted edit-session drafts (newer than `content`/`enhancedContent`). */
  draftContent?: string | null;
  draftEnhancedContent?: string | null;
  recordedAt?: string | null;
  createdAt?: string | null;
  audioDurationSeconds?: number | null;
  isRecording?: boolean;
  /** Persist pending debounced edits before the snapshot is taken. */
  flush?: () => Promise<void>;
}

export interface NoteActionSnapshot {
  note: NoteActionNote;
  sources: Record<NoteActionSnapshotField, NoteActionFieldSource>;
  /** Compact summary for logs, e.g. "draft+memory+live+db". */
  snapshotSource: string;
  isRecording: boolean;
  usedLiveContext: boolean;
}

function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

export function resolveNoteActionSnapshot(
  dbNote: Partial<NoteActionNote> | null | undefined,
  live: NoteActionLiveContext | undefined
): NoteActionSnapshot {
  const sources: Record<NoteActionSnapshotField, NoteActionFieldSource> = {
    title: "db",
    content: "db",
    enhanced_content: "db",
    transcript: "db",
  };

  let title = dbNote?.title ?? "";
  if (isSet(live?.title)) {
    title = String(live?.title ?? "");
    sources.title = "memory";
  }

  let content = dbNote?.content ?? null;
  if (isSet(live?.draftContent)) {
    content = live?.draftContent ?? null;
    sources.content = "draft";
  } else if (isSet(live?.content)) {
    content = live?.content ?? null;
    sources.content = "memory";
  }

  let enhancedContent = dbNote?.enhanced_content ?? null;
  if (isSet(live?.draftEnhancedContent)) {
    enhancedContent = live?.draftEnhancedContent ?? null;
    sources.enhanced_content = "draft";
  } else if (isSet(live?.enhancedContent)) {
    enhancedContent = live?.enhancedContent ?? null;
    sources.enhanced_content = "memory";
  }

  let transcript = dbNote?.transcript ?? null;
  if (isSet(live?.transcript)) {
    transcript = live?.transcript ?? null;
    sources.transcript = live?.transcriptIsLive ? "live" : "memory";
  }

  const note: NoteActionNote = {
    title,
    content,
    enhanced_content: enhancedContent,
    transcript,
    recorded_at: live?.recordedAt ?? dbNote?.recorded_at ?? null,
    created_at: live?.createdAt ?? dbNote?.created_at ?? "",
    audio_duration_seconds: isSet(live?.audioDurationSeconds)
      ? (live?.audioDurationSeconds ?? null)
      : (dbNote?.audio_duration_seconds ?? null),
  };

  const ordered = (["draft", "memory", "live", "db"] as NoteActionFieldSource[]).filter((source) =>
    Object.values(sources).includes(source)
  );

  return {
    note,
    sources,
    snapshotSource: ordered.join("+"),
    isRecording: !!live?.isRecording,
    usedLiveContext: !!live,
  };
}
