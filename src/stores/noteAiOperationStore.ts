/**
 * Per-note AI operation store: backs the right-docked drawer that hosts
 * 选段润色 and 笔记动作 (优化转录文本 etc.) with live reasoning streams, token
 * usage and review/apply.
 *
 * Operations live here — not in component state — so a run survives the note
 * editor unmounting (the nav-away prompt offers "后台跑完并自动应用"). Apply
 * goes through the editor's registered handler while the note is open, and
 * falls back to a direct DB write (matched by the pre-polish text, which is
 * stable across sessions, unlike segment ids) when it is not.
 */

import { create } from "zustand";
import type { ReasoningStreamEvent, ReasoningTokenUsage } from "../services/BaseReasoningService";
import { applyTranscriptPolishUpdates, type PolishLine } from "./transcriptPolishCore";
import { parseTranscriptSegments } from "../utils/parseTranscriptSegments";
import { serializeTranscriptSegments } from "../utils/transcriptSpeakerState";
import { updateNoteInStore } from "./noteStore";
import {
  runTranscriptPolish,
  type RunTranscriptPolishResult,
  type TranscriptPolishFailedChunk,
} from "./runTranscriptPolish";
import logger from "../utils/logger";

export type AiOperationKind = "polish" | "action";
export type AiChunkPhase = "queued" | "streaming" | "done" | "error";
export type AiOperationStatus = "running" | "awaiting-review" | "applying" | "done" | "error";

/** Reasoning text is display-only; cap it so a long run cannot grow memory. */
const STREAM_TEXT_CAP = 6000;

export interface AiChunkState {
  index: number;
  phase: AiChunkPhase;
  reasoningChars: number;
  contentChars: number;
  /** Tail of the reasoning stream (capped at STREAM_TEXT_CAP chars). */
  reasoningText: string;
  /** Tail of the content stream (capped). */
  contentText: string;
  usage?: ReasoningTokenUsage;
  startedAt?: number;
  firstTokenAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface NoteAiOperation {
  noteId: number;
  kind: AiOperationKind;
  /** Display title: "AI 润色" or the action name. */
  title: string;
  status: AiOperationStatus;
  chunks: AiChunkState[];
  startedAt: number;
  finishedAt?: number;
  errorMessage?: string;
  /** Nav-away choice: finish in background and apply without review. */
  autoApply: boolean;
  /** Polish payload (kept for review + chunk retry). */
  polishLines?: PolishLine[];
  polishSelectedIds?: string[];
  polishNoteContent?: string | null;
  polishResult?: RunTranscriptPolishResult;
  appliedCount?: number;
}

interface NoteAiOperationStoreState {
  operations: Record<number, NoteAiOperation>;
  drawerOpen: Record<number, boolean>;
}

export const useNoteAiOperationStore = create<NoteAiOperationStoreState>()(() => ({
  operations: {},
  drawerOpen: {},
}));

export function useNoteAiOperation(noteId: number | null | undefined): NoteAiOperation | undefined {
  return useNoteAiOperationStore((state) =>
    noteId == null ? undefined : state.operations[noteId]
  );
}

export function useNoteAiDrawerOpen(noteId: number | null | undefined): boolean {
  return useNoteAiOperationStore((state) =>
    noteId == null ? false : (state.drawerOpen[noteId] ?? false)
  );
}

/** Editor-registered apply handler (mounted note) — non-reactive by design. */
const polishApplyHandlers = new Map<
  number,
  (updates: Array<{ id: string; text: string }>) => void
>();

export function registerPolishApplyHandler(
  noteId: number,
  handler: (updates: Array<{ id: string; text: string }>) => void
): () => void {
  polishApplyHandlers.set(noteId, handler);
  return () => {
    if (polishApplyHandlers.get(noteId) === handler) polishApplyHandlers.delete(noteId);
  };
}

function patchOperation(noteId: number, patch: Partial<NoteAiOperation>) {
  const { operations } = useNoteAiOperationStore.getState();
  const prev = operations[noteId];
  if (!prev) return;
  useNoteAiOperationStore.setState({
    operations: { ...operations, [noteId]: { ...prev, ...patch } },
  });
}

function patchChunk(noteId: number, index: number, patch: Partial<AiChunkState>) {
  const { operations } = useNoteAiOperationStore.getState();
  const prev = operations[noteId];
  if (!prev) return;
  const chunks = prev.chunks.map((chunk) =>
    chunk.index === index ? { ...chunk, ...patch } : chunk
  );
  patchOperation(noteId, { chunks });
}

function capText(text: string): string {
  return text.length > STREAM_TEXT_CAP ? `…${text.slice(-STREAM_TEXT_CAP)}` : text;
}

function applyStreamEventToChunk(chunk: AiChunkState, event: ReasoningStreamEvent): AiChunkState {
  const now = Date.now();
  switch (event.type) {
    case "attempt-start":
      return {
        ...chunk,
        phase: "streaming",
        reasoningChars: 0,
        contentChars: 0,
        reasoningText: "",
        contentText: "",
        usage: undefined,
        error: undefined,
        startedAt: chunk.startedAt ?? now,
        firstTokenAt: undefined,
        finishedAt: undefined,
      };
    case "reasoning-delta":
      return {
        ...chunk,
        phase: "streaming",
        firstTokenAt: chunk.firstTokenAt ?? now,
        reasoningChars: chunk.reasoningChars + event.text.length,
        reasoningText: capText(chunk.reasoningText + event.text),
      };
    case "content-delta":
      return {
        ...chunk,
        phase: "streaming",
        firstTokenAt: chunk.firstTokenAt ?? now,
        contentChars: chunk.contentChars + event.text.length,
        contentText: capText(chunk.contentText + event.text),
      };
    case "completed":
    case "incomplete":
      return { ...chunk, phase: "done", usage: event.usage ?? chunk.usage, finishedAt: now };
    case "failed":
      return { ...chunk, phase: "error", error: event.message, finishedAt: now };
    default:
      return chunk;
  }
}

export function setNoteAiDrawerOpen(noteId: number, open: boolean) {
  const { drawerOpen } = useNoteAiOperationStore.getState();
  useNoteAiOperationStore.setState({ drawerOpen: { ...drawerOpen, [noteId]: open } });
}

export function clearNoteAiOperation(noteId: number) {
  const { operations, drawerOpen } = useNoteAiOperationStore.getState();
  const nextOps = { ...operations };
  delete nextOps[noteId];
  const nextOpen = { ...drawerOpen };
  delete nextOpen[noteId];
  useNoteAiOperationStore.setState({ operations: nextOps, drawerOpen: nextOpen });
}

/** True while a run for this note should hold the user on the note. */
export function isNoteAiOperationActive(noteId: number): boolean {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  return !!op && (op.status === "running" || op.status === "awaiting-review");
}

/* ------------------------------------------------------------------ */
/* 笔记动作（优化转录文本等）                                            */
/* ------------------------------------------------------------------ */

export function startActionOperation(noteId: number, actionName: string) {
  const { operations } = useNoteAiOperationStore.getState();
  const op: NoteAiOperation = {
    noteId,
    kind: "action",
    title: actionName,
    status: "running",
    autoApply: false,
    startedAt: Date.now(),
    chunks: [
      {
        index: 0,
        phase: "queued",
        reasoningChars: 0,
        contentChars: 0,
        reasoningText: "",
        contentText: "",
      },
    ],
  };
  useNoteAiOperationStore.setState({
    operations: { ...operations, [noteId]: op },
    drawerOpen: { ...useNoteAiOperationStore.getState().drawerOpen, [noteId]: true },
  });
}

export function updateActionStream(noteId: number, event: ReasoningStreamEvent) {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op || op.kind !== "action" || op.chunks.length === 0) return;
  patchChunk(noteId, 0, applyStreamEventToChunk(op.chunks[0], event));
}

export function finishActionOperation(noteId: number, ok: boolean, message?: string) {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op || op.kind !== "action") return;
  const chunks = op.chunks.map((chunk) =>
    chunk.phase === "streaming" || chunk.phase === "queued"
      ? { ...chunk, phase: ok ? ("done" as const) : ("error" as const), finishedAt: Date.now() }
      : chunk
  );
  patchOperation(noteId, {
    status: ok ? "done" : "error",
    errorMessage: ok ? undefined : message,
    finishedAt: Date.now(),
    chunks,
  });
}

/* ------------------------------------------------------------------ */
/* 选段润色                                                             */
/* ------------------------------------------------------------------ */

export interface StartPolishInput {
  lines: PolishLine[];
  selectedIds: string[];
  noteContent?: string | null;
}

export async function startPolishOperation(noteId: number, input: StartPolishInput): Promise<void> {
  const { operations, drawerOpen } = useNoteAiOperationStore.getState();
  if (operations[noteId]?.status === "running") return; // one run per note
  const op: NoteAiOperation = {
    noteId,
    kind: "polish",
    title: "polish",
    status: "running",
    autoApply: false,
    startedAt: Date.now(),
    chunks: [],
    polishLines: input.lines,
    polishSelectedIds: input.selectedIds,
    polishNoteContent: input.noteContent ?? null,
  };
  useNoteAiOperationStore.setState({
    operations: { ...operations, [noteId]: op },
    drawerOpen: { ...drawerOpen, [noteId]: true },
  });

  try {
    const result = await runTranscriptPolish({
      lines: input.lines,
      selectedIds: input.selectedIds,
      noteContent: input.noteContent,
      noteId,
      onProgress: (done, total) => {
        const current = useNoteAiOperationStore.getState().operations[noteId];
        if (!current) return;
        if (current.chunks.length !== total) {
          const chunks: AiChunkState[] = Array.from({ length: total }, (_, index) => ({
            index,
            phase: "queued" as const,
            reasoningChars: 0,
            contentChars: 0,
            reasoningText: "",
            contentText: "",
          }));
          patchOperation(noteId, { chunks });
        }
      },
      onChunkStream: (chunkIndex, event) => {
        const current = useNoteAiOperationStore.getState().operations[noteId];
        const chunk = current?.chunks[chunkIndex];
        if (!chunk) return;
        patchChunk(noteId, chunkIndex, applyStreamEventToChunk(chunk, event));
      },
    });

    const current = useNoteAiOperationStore.getState().operations[noteId];
    if (!current) return;
    // Non-streaming providers never emit events — close out their cards.
    const failedIndexes = new Set(result.failedChunks.map((chunk) => chunk.chunkIndex));
    const chunks = current.chunks.map((chunk) => {
      if (failedIndexes.has(chunk.index)) {
        return {
          ...chunk,
          phase: "error" as const,
          error: result.failedChunks.find((f) => f.chunkIndex === chunk.index)?.message,
          finishedAt: Date.now(),
        };
      }
      return chunk.phase === "queued" || chunk.phase === "streaming"
        ? { ...chunk, phase: "done" as const, finishedAt: Date.now() }
        : chunk;
    });
    patchOperation(noteId, { polishResult: result, chunks });

    await maybeAutoApply(noteId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = useNoteAiOperationStore.getState().operations[noteId];
    patchOperation(noteId, {
      status: "error",
      errorMessage: message,
      finishedAt: Date.now(),
      chunks: (current?.chunks ?? []).map((chunk) =>
        chunk.phase === "streaming" || chunk.phase === "queued"
          ? { ...chunk, phase: "error" as const, finishedAt: Date.now() }
          : chunk
      ),
    });
  }
}

/** After a run completes: await review, or auto-apply when the user left. */
async function maybeAutoApply(noteId: number) {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op || !op.polishResult) return;
  if (op.autoApply) {
    await applyPolishUpdates(
      noteId,
      op.polishResult.updates.map(({ id, text }) => ({ id, text }))
    );
    return;
  }
  patchOperation(noteId, { status: "awaiting-review" });
}

/**
 * Apply accepted polish updates. While the note is open the editor's handler
 * writes (keeps in-memory state + persistence consistent); otherwise write
 * straight to the DB, matching segments by their pre-polish text.
 */
export async function applyPolishUpdates(
  noteId: number,
  updates: Array<{ id: string; text: string }>
): Promise<void> {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op || updates.length === 0) {
    if (op) patchOperation(noteId, { status: "done", appliedCount: 0, finishedAt: Date.now() });
    return;
  }
  patchOperation(noteId, { status: "applying" });

  const editorHandler = polishApplyHandlers.get(noteId);
  if (editorHandler) {
    editorHandler(updates);
    patchOperation(noteId, {
      status: "done",
      appliedCount: updates.length,
      finishedAt: Date.now(),
    });
    return;
  }

  // Background path: the editor is unmounted, so write via the DB. Segment
  // ids are session-local (diarization assigns its own), so match on the
  // exact pre-polish text instead — that is the invariant across sessions.
  try {
    const note = await window.electronAPI.getNote(noteId);
    const segments = parseTranscriptSegments(note?.transcript ?? "", {});
    const remaining = (op.polishResult?.updates ?? [])
      .filter((update) => updates.some((accepted) => accepted.id === update.id))
      .map((update) => ({ ...update }));
    let applied = 0;
    const next = segments.map((segment) => {
      const hit = remaining.find((update) => update.previousText === segment.text);
      if (!hit) return segment;
      remaining.splice(remaining.indexOf(hit), 1);
      applied += 1;
      return {
        ...segment,
        text: hit.text,
        editedByUser: true,
        originalText: segment.originalText ?? segment.text,
        learnedText: hit.text,
      };
    });
    if (applied > 0) {
      const result = await window.electronAPI.updateNote(noteId, {
        transcript: serializeTranscriptSegments(next),
      });
      if (result?.note) updateNoteInStore(result.note);
    }
    if (applied < updates.length) {
      logger.warn("[NoteAiDrawer] background apply matched fewer segments than requested", {
        noteId,
        requested: updates.length,
        applied,
      });
    }
    patchOperation(noteId, { status: "done", appliedCount: applied, finishedAt: Date.now() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patchOperation(noteId, { status: "error", errorMessage: message, finishedAt: Date.now() });
  }
}

/** Nav-away choice: run to completion in the background and apply everything. */
export function requestAutoApplyAndLeave(noteId: number) {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op) return;
  patchOperation(noteId, { autoApply: true });
  if (op.status === "awaiting-review" && op.polishResult) {
    void applyPolishUpdates(
      noteId,
      op.polishResult.updates.map(({ id, text }) => ({ id, text }))
    );
  }
}

/** Re-run one failed chunk and merge its result into the existing review. */
export async function retryPolishChunk(noteId: number, failed: TranscriptPolishFailedChunk) {
  const op = useNoteAiOperationStore.getState().operations[noteId];
  if (!op?.polishResult || !op.polishLines || !op.polishSelectedIds) return;
  patchOperation(noteId, { status: "running" });
  patchChunk(noteId, failed.chunkIndex, {
    phase: "queued",
    error: undefined,
    finishedAt: undefined,
  });

  try {
    const result = await runTranscriptPolish({
      lines: op.polishLines,
      selectedIds: failed.segmentIds,
      noteContent: op.polishNoteContent,
      noteId,
      onChunkStream: (_index, event) => {
        const current = useNoteAiOperationStore.getState().operations[noteId];
        const chunk = current?.chunks[failed.chunkIndex];
        if (chunk) patchChunk(noteId, failed.chunkIndex, applyStreamEventToChunk(chunk, event));
      },
    });

    const current = useNoteAiOperationStore.getState().operations[noteId];
    if (!current?.polishResult) return;
    const prev = current.polishResult;
    const retryIds = new Set(failed.segmentIds);
    const merged: RunTranscriptPolishResult = {
      ...prev,
      updates: [...prev.updates.filter((update) => !retryIds.has(update.id)), ...result.updates],
      missingIds: prev.missingIds.filter((id) => !retryIds.has(id)),
      failedChunks: [
        ...prev.failedChunks.filter((chunk) => chunk.chunkIndex !== failed.chunkIndex),
        ...result.failedChunks,
      ],
    };
    patchChunk(noteId, failed.chunkIndex, {
      phase: result.failedChunks.length > 0 ? "error" : "done",
      error: result.failedChunks[0]?.message,
      finishedAt: Date.now(),
    });
    patchOperation(noteId, { polishResult: merged });
    await maybeAutoApply(noteId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    patchChunk(noteId, failed.chunkIndex, {
      phase: "error",
      error: message,
      finishedAt: Date.now(),
    });
    const current = useNoteAiOperationStore.getState().operations[noteId];
    if (current?.polishResult) {
      patchOperation(noteId, {
        status: "awaiting-review",
        polishResult: {
          ...current.polishResult,
          failedChunks: [
            ...current.polishResult.failedChunks.filter((c) => c.chunkIndex !== failed.chunkIndex),
            { ...failed, message },
          ],
        },
      });
    } else {
      patchOperation(noteId, { status: "error", errorMessage: message });
    }
  }
}
