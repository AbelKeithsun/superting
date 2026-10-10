/**
 * Renderer-side registry of "what the note on screen looks like right now".
 *
 * `PersonalNotesView` publishes the committed editor state (and a flush hook for
 * its debounced saves); `NoteEditor` additionally publishes uncommitted
 * edit-session drafts. The note-action executor reads it so both entry points
 * run against identical, newest-first content.
 *
 * Deliberately a plain module-level Map (not a zustand store): it is written on
 * every keystroke but never read reactively, so it must not trigger re-renders.
 */

import type { NoteItem } from "../types/electron";
import { logNoteAction } from "./noteActionLogger";
import {
  resolveNoteActionSnapshot,
  type NoteActionLiveContext,
  type NoteActionSnapshot,
} from "./noteActionSnapshot";

const contexts = new Map<number, NoteActionLiveContext>();

/** Merge a patch into the live context. `null` clears a field, `undefined` skips it. */
export function publishNoteActionContext(noteId: number, patch: NoteActionLiveContext): void {
  if (!Number.isFinite(noteId)) return;
  const prev = contexts.get(noteId) ?? {};
  const next: NoteActionLiveContext = { ...prev };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (next as Record<string, unknown>)[key] = value;
  }
  contexts.set(noteId, next);
}

export function clearNoteActionContext(noteId: number): void {
  contexts.delete(noteId);
}

export function getNoteActionContext(noteId: number): NoteActionLiveContext | undefined {
  return contexts.get(noteId);
}

export interface LoadedNoteActionSnapshot extends NoteActionSnapshot {
  /** No live context and no DB row: the executor must refuse to run. */
  noteMissing: boolean;
  dbReadFailed: boolean;
}

async function readNoteFromDb(noteId: number): Promise<{
  note: NoteItem | null;
  failed: boolean;
}> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.getNote) return { note: null, failed: false };
  try {
    const note = await api.getNote(noteId);
    return { note: note ?? null, failed: false };
  } catch (error) {
    logNoteAction(
      "NOTE_ACTION_DB_SNAPSHOT_FAILED",
      { noteId, error: error instanceof Error ? error.message : String(error) },
      "warn"
    );
    return { note: null, failed: true };
  }
}

/**
 * Take the snapshot a note action will run against: flush pending edits first,
 * prefer live renderer state, fall back to the persisted note.
 */
export async function loadNoteActionSnapshot(noteId: number): Promise<LoadedNoteActionSnapshot> {
  const live = contexts.get(noteId);

  if (live?.flush) {
    try {
      await live.flush();
    } catch (error) {
      logNoteAction(
        "NOTE_ACTION_FLUSH_FAILED",
        { noteId, error: error instanceof Error ? error.message : String(error) },
        "warn"
      );
    }
  }

  const { note: dbNote, failed } = await readNoteFromDb(noteId);
  const snapshot = resolveNoteActionSnapshot(dbNote, live);

  return {
    ...snapshot,
    noteMissing: !dbNote && !live,
    dbReadFailed: failed,
  };
}
