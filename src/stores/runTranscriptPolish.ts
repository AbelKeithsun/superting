import reasoningService from "../services/ReasoningService";
import { getSettings } from "./settingsStore";
import { resolveNoteFormattingRequest } from "./noteFormattingRequest";
import {
  buildTranscriptPolishMessages,
  buildTranscriptPolishSystemPrompt,
  buildTranscriptPolishUpdates,
  chunkPolishTargets,
  parseTranscriptPolishResponse,
  polishContextCharCap,
  polishNoteCharCap,
  slicePolishContext,
  TRANSCRIPT_POLISH_MAX_SELECTION_CHARS,
  TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS,
  TRANSCRIPT_POLISH_PARALLELISM,
  type PolishLine,
  type TranscriptPolishUpdate,
} from "./transcriptPolishCore";
import {
  computeNoteActionMaxTokens,
  noteActionMaxTokensCeiling,
  NOTE_ACTION_REQUEST_TIMEOUT_MS,
} from "./noteActionBudget.js";
import { logNoteAction } from "./noteActionLogger";
import { baseSegmentIdForDisplayChunk } from "../utils/speakerAssignment";

export type TranscriptPolishErrorReason =
  | "no-selection"
  | "non-contiguous"
  | "selection-too-large"
  | "selection-too-many"
  | "empty-response"
  | "unparsed-response";

/** Carries a machine-readable reason so the UI can localise the message. */
export class TranscriptPolishError extends Error {
  readonly reason: TranscriptPolishErrorReason;

  constructor(reason: TranscriptPolishErrorReason, message: string) {
    super(message);
    this.name = "TranscriptPolishError";
    this.reason = reason;
  }
}

export interface RunTranscriptPolishInput {
  /** Every segment of the note, in transcript order. */
  lines: PolishLine[];
  /** Ids the user selected; must be a contiguous run of `lines`. */
  selectedIds: string[];
  /** Note body — terminology context only, never rewritten. */
  noteContent?: string | null;
  modelId?: string;
  isCloudMode?: boolean;
  noteId?: number;
  /** Progress for multi-chunk runs: (completed chunks, total chunks). */
  onProgress?: (done: number, total: number) => void;
}

export interface RunTranscriptPolishResult {
  updates: TranscriptPolishUpdate[];
  /** Selected segments the model did not return; they keep their text. */
  missingIds: string[];
  mode: "numbered" | "ordered-lines";
  selectionChars: number;
}

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Rewrite only the selected transcript segments.
 *
 * This is the segment-scoped counterpart of the whole-note actions: the output
 * budget scales with the *selection*, so a long meeting never runs into the
 * output ceiling that made the whole-transcript "优化转录文本" action fail, and
 * nothing outside the selection can be touched.
 *
 * Latency levers (interactive UX — the user is staring at a spinner):
 * - reasoning effort is pinned low (disableThinking) — a proofreading pass
 *   does not need deep thought, and on deepseek-flash the default effort was
 *   the dominant cost;
 * - context/note windows scale with the selection instead of maxing out;
 * - a multi-block selection is chunked and the chunks run in parallel, so
 *   wall-clock ≈ the slowest chunk instead of the sum.
 */
export async function runTranscriptPolish({
  lines,
  selectedIds,
  noteContent,
  modelId,
  isCloudMode = false,
  noteId,
  onProgress,
}: RunTranscriptPolishInput): Promise<RunTranscriptPolishResult> {
  const operationId = `note-${noteId ?? -1}-transcript-polish-${Date.now()}`;
  // Defensive: the transcript view splits long segments into display-only
  // chunks with synthetic `:part-N` ids. Normalise back to real segment ids so
  // a continuation block can never miss every line and read as "no selection".
  const selected = new Set(selectedIds.map(baseSegmentIdForDisplayChunk));
  const indices = lines
    .map((line, index) => (line.id && selected.has(line.id) ? index : -1))
    .filter((index) => index >= 0);

  if (indices.length === 0) {
    throw new TranscriptPolishError("no-selection", "No transcript segments selected");
  }
  const startIndex = indices[0];
  const endIndex = indices[indices.length - 1];
  if (endIndex - startIndex + 1 !== indices.length) {
    throw new TranscriptPolishError(
      "non-contiguous",
      "The selected transcript segments must be contiguous"
    );
  }

  const targets = lines.slice(startIndex, endIndex + 1);
  const selectionChars = targets.reduce((total, line) => total + line.text.length, 0);

  if (targets.length > TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS) {
    throw new TranscriptPolishError(
      "selection-too-many",
      `Select at most ${TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS} segments (selected ${targets.length})`
    );
  }
  if (selectionChars > TRANSCRIPT_POLISH_MAX_SELECTION_CHARS) {
    throw new TranscriptPolishError(
      "selection-too-large",
      `Select at most ${TRANSCRIPT_POLISH_MAX_SELECTION_CHARS} characters (selected ${selectionChars})`
    );
  }

  const customDictionary = getSettings().customDictionary;
  const chunks = chunkPolishTargets(targets);
  // Each chunk's offset within `targets`, so its context slice can be located
  // in the full `lines` array.
  const chunkStartOffsets: number[] = [];
  {
    let offset = 0;
    for (const chunk of chunks) {
      chunkStartOffsets.push(offset);
      offset += chunk.length;
    }
  }

  const resolveChunk = (chunk: PolishLine[], chunkChars: number, systemPrompt: string) =>
    resolveNoteFormattingRequest({
      modelId,
      systemPrompt,
      isCloudMode,
      // Only the chunk's segments are re-emitted, so the budget follows the
      // chunk size rather than the whole selection.
      maxTokensForProvider: (provider) =>
        computeNoteActionMaxTokens(chunkChars, noteActionMaxTokensCeiling(provider)),
      timeoutMs: NOTE_ACTION_REQUEST_TIMEOUT_MS,
      temperature: 0.2,
      disableThinking: true,
    });

  // Fail fast on "no model configured" before firing any request.
  const firstChunkChars = chunks[0].reduce((total, line) => total + line.text.length, 0);
  const probe = resolveChunk(
    chunks[0],
    firstChunkChars,
    buildTranscriptPolishSystemPrompt(customDictionary)
  );
  if (!probe.hasModel) {
    throw new Error("No AI model selected");
  }

  logNoteAction("TRANSCRIPT_POLISH_REQUEST", {
    operationId,
    noteId: noteId ?? -1,
    segmentCount: targets.length,
    selectionChars,
    chunkCount: chunks.length,
    selectedModel: probe.selectedModel,
    resolvedMode: probe.resolvedFormatting.mode,
    provider: probe.resolvedFormatting.provider || null,
  });

  onProgress?.(0, chunks.length);
  let done = 0;

  const results = await mapPool(
    chunks,
    TRANSCRIPT_POLISH_PARALLELISM,
    async (chunk, chunkIndex) => {
      const chunkChars = chunk.reduce((total, line) => total + line.text.length, 0);
      const offset = chunkStartOffsets[chunkIndex];
      const { before, after } = slicePolishContext(
        lines,
        startIndex + offset,
        startIndex + offset + chunk.length - 1,
        polishContextCharCap(chunkChars)
      );
      const { systemPrompt, userMessage } = buildTranscriptPolishMessages({
        targets: chunk,
        before,
        after,
        noteContent,
        customDictionary,
        maxNoteChars: polishNoteCharCap(chunkChars),
      });
      const { selectedModel, reasoningConfig } = resolveChunk(chunk, chunkChars, systemPrompt);

      const raw = await reasoningService.processText(
        userMessage,
        selectedModel,
        null,
        reasoningConfig
      );

      const parsed = parseTranscriptPolishResponse(raw, chunk);
      if (parsed.entries.length === 0) {
        logNoteAction(
          "TRANSCRIPT_POLISH_UNPARSED",
          {
            operationId,
            noteId: noteId ?? -1,
            chunkIndex,
            segmentCount: chunk.length,
            selectedModel,
            responseLength: String(raw ?? "").length,
            responseHead: String(raw ?? "").slice(0, 300),
          },
          "error"
        );
        throw new TranscriptPolishError(
          "unparsed-response",
          "The model did not return one line per selected segment"
        );
      }

      done += 1;
      onProgress?.(done, chunks.length);
      return { ...buildTranscriptPolishUpdates(chunk, parsed), mode: parsed.mode };
    }
  );

  const updates = results.flatMap((result) => result.updates);
  const missingIds = results.flatMap((result) => result.missingIds);
  const mode = results.every((result) => result.mode === "ordered-lines")
    ? "ordered-lines"
    : "numbered";

  logNoteAction("TRANSCRIPT_POLISH_RESULT", {
    operationId,
    noteId: noteId ?? -1,
    segmentCount: targets.length,
    chunkCount: chunks.length,
    changedCount: updates.length,
    missingCount: missingIds.length,
    mode,
  });

  return { updates, missingIds, mode, selectionChars };
}
