import reasoningService from "../services/ReasoningService";
import { getSettings } from "./settingsStore";
import { resolveNoteFormattingRequest } from "./noteFormattingRequest";
import {
  buildTranscriptPolishMessages,
  buildTranscriptPolishUpdates,
  parseTranscriptPolishResponse,
  TRANSCRIPT_POLISH_CONTEXT_SEGMENTS,
  TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS,
  TRANSCRIPT_POLISH_MAX_SELECTION_CHARS,
  TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS,
  type PolishLine,
  type TranscriptPolishUpdate,
} from "./transcriptPolishCore";
import {
  computeNoteActionMaxTokens,
  noteActionMaxTokensCeiling,
  NOTE_ACTION_REQUEST_TIMEOUT_MS,
} from "./noteActionBudget.js";
import { logNoteAction } from "./noteActionLogger";

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
}

export interface RunTranscriptPolishResult {
  updates: TranscriptPolishUpdate[];
  /** Selected segments the model did not return; they keep their text. */
  missingIds: string[];
  mode: "numbered" | "ordered-lines";
  selectionChars: number;
}

function sliceContext(
  lines: PolishLine[],
  startIndex: number,
  endIndex: number
): { before: PolishLine[]; after: PolishLine[] } {
  const before = lines.slice(
    Math.max(0, startIndex - TRANSCRIPT_POLISH_CONTEXT_SEGMENTS),
    startIndex
  );
  const after = lines.slice(endIndex + 1, endIndex + 1 + TRANSCRIPT_POLISH_CONTEXT_SEGMENTS);
  const cap = (list: PolishLine[]): PolishLine[] => {
    let total = 0;
    const kept: PolishLine[] = [];
    // Keep the neighbours closest to the selection when the context is long.
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const line = list[i];
      const length = line.text.length;
      if (total + length > TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS) break;
      total += length;
      kept.unshift(line);
    }
    return kept;
  };
  return { before: cap(before), after: cap(after) };
}

/**
 * Rewrite only the selected transcript segments.
 *
 * This is the segment-scoped counterpart of the whole-note actions: the output
 * budget scales with the *selection*, so a long meeting never runs into the
 * output ceiling that made the whole-transcript "优化转录文本" action fail, and
 * nothing outside the selection can be touched.
 */
export async function runTranscriptPolish({
  lines,
  selectedIds,
  noteContent,
  modelId,
  isCloudMode = false,
  noteId,
}: RunTranscriptPolishInput): Promise<RunTranscriptPolishResult> {
  const operationId = `note-${noteId ?? -1}-transcript-polish-${Date.now()}`;
  const selected = new Set(selectedIds);
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

  const { before, after } = sliceContext(lines, startIndex, endIndex);
  const { systemPrompt, userMessage } = buildTranscriptPolishMessages({
    targets,
    before,
    after,
    noteContent,
    customDictionary: getSettings().customDictionary,
  });

  const { selectedModel, reasoningConfig, resolvedFormatting, hasModel } =
    resolveNoteFormattingRequest({
      modelId,
      systemPrompt,
      isCloudMode,
      // Only the selected segments are re-emitted, so the budget follows the
      // selection size rather than the whole transcript.
      maxTokensForProvider: (provider) =>
        computeNoteActionMaxTokens(selectionChars, noteActionMaxTokensCeiling(provider)),
      timeoutMs: NOTE_ACTION_REQUEST_TIMEOUT_MS,
      temperature: 0.2,
    });

  if (!hasModel) {
    throw new Error("No AI model selected");
  }

  logNoteAction("TRANSCRIPT_POLISH_REQUEST", {
    operationId,
    noteId: noteId ?? -1,
    segmentCount: targets.length,
    selectionChars,
    contextBefore: before.length,
    contextAfter: after.length,
    selectedModel,
    resolvedMode: resolvedFormatting.mode,
    provider: resolvedFormatting.provider || null,
  });

  const raw = await reasoningService.processText(userMessage, selectedModel, null, reasoningConfig);

  const parsed = parseTranscriptPolishResponse(raw, targets);
  if (parsed.entries.length === 0) {
    logNoteAction(
      "TRANSCRIPT_POLISH_UNPARSED",
      {
        operationId,
        noteId: noteId ?? -1,
        segmentCount: targets.length,
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

  const { updates, missingIds } = buildTranscriptPolishUpdates(targets, parsed);
  logNoteAction("TRANSCRIPT_POLISH_RESULT", {
    operationId,
    noteId: noteId ?? -1,
    segmentCount: targets.length,
    changedCount: updates.length,
    missingCount: missingIds.length,
    mode: parsed.mode,
    duplicated: parsed.duplicated,
  });

  return { updates, missingIds, mode: parsed.mode, selectionChars };
}
