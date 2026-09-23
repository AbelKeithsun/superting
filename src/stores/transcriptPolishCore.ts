/**
 * Pure helpers for "AI 润色选中的转录段落" (segment-scoped transcript polish).
 *
 * Scope, by design: the model only ever rewrites the segments the user selected,
 * one output line per input segment, and the caller writes the result back into
 * those transcript segments only. It must NOT summarise, merge or reorder — that
 * is what the whole-note actions (会议纪要 etc.) are for. See
 * noteActionPrompt.ts: the meeting wrapper deliberately tells the model to
 * consolidate repeated turns, which is the opposite of a per-segment polish, so
 * this path carries its own prompt instead of reusing the action wrapper.
 *
 * Everything here is dependency-free so the Node test runner can load it.
 */

import { buildDictionaryInstruction } from "../config/dictionaryPrompt.js";

export interface PolishLine {
  /** Segment id (targets) — absent for read-only context lines. */
  id?: string;
  /** ASR text, single line (newlines are collapsed before prompting). */
  text: string;
  /**
   * Display label without the trailing colon, e.g. `[00:12] 你` or `对方`.
   * Echoed on input so the model can see who is speaking, and stripped again on
   * output in case the model echoes it back.
   */
  label: string;
}

export interface TranscriptPolishMessages {
  systemPrompt: string;
  userMessage: string;
}

export interface TranscriptPolishParseResult {
  /** Matched lines, in the order they appeared. */
  entries: Array<{ index: number; text: string }>;
  /** `how` records which protocol the response actually followed. */
  mode: "numbered" | "ordered-lines";
  missing: number[];
  unexpected: number[];
  duplicated: number[];
}

export interface TranscriptPolishUpdate {
  id: string;
  text: string;
  previousText: string;
}

/**
 * A selection is meant to be reviewed before it is applied, so keep a cap — but
 * a generous one: chunks run in parallel with per-chunk budgets, so 24k
 * characters (roughly 10-12 minutes of speech) costs the latency of the slowest
 * chunk, not the sum.
 */
export const TRANSCRIPT_POLISH_MAX_SELECTION_CHARS = 24000;
export const TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS = 120;
/**
 * Read-only neighbours sent along so pronouns/homophones can be resolved. Two
 * per side is plenty — the model does not need to re-read the meeting to fix a
 * line, and every context char costs reasoning tokens (latency).
 */
export const TRANSCRIPT_POLISH_CONTEXT_SEGMENTS = 2;
export const TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS = 2000;
/** The note body is context only (terminology, names) — never rewritten. */
export const TRANSCRIPT_POLISH_MAX_NOTE_CHARS = 1500;

/**
 * Chunking for the parallel runner: a selection bigger than this is split into
 * independent requests that run concurrently, so polishing N blocks costs the
 * latency of the slowest chunk instead of the sum. Kept above one speaker
 * block (≤60s / ≤420 chars) so a single block is always one request.
 */
export const TRANSCRIPT_POLISH_CHUNK_SEGMENTS = 8;
export const TRANSCRIPT_POLISH_CHUNK_CHARS = 1500;
export const TRANSCRIPT_POLISH_PARALLELISM = 3;

/**
 * Split a validated selection into request-sized chunks, in order. A segment
 * is never split; only oversize *selections* are.
 */
export function chunkPolishTargets(
  targets: PolishLine[],
  maxSegments = TRANSCRIPT_POLISH_CHUNK_SEGMENTS,
  maxChars = TRANSCRIPT_POLISH_CHUNK_CHARS
): PolishLine[][] {
  const chunks: PolishLine[][] = [];
  let current: PolishLine[] = [];
  let chars = 0;
  for (const target of targets) {
    const length = target.text.length;
    if (current.length > 0 && (current.length >= maxSegments || chars + length > maxChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(target);
    chars += length;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Read-only neighbours of lines[startIndex..endIndex], capped per side. Both
 * sides keep the lines *closest* to the selection when the char cap binds
 * (the after side walks forward, the before side walks backward).
 */
export function slicePolishContext(
  lines: PolishLine[],
  startIndex: number,
  endIndex: number,
  maxChars = TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS,
  maxSegments = TRANSCRIPT_POLISH_CONTEXT_SEGMENTS
): { before: PolishLine[]; after: PolishLine[] } {
  const beforeAll = lines.slice(Math.max(0, startIndex - maxSegments), startIndex);
  const before: PolishLine[] = [];
  let total = 0;
  for (let i = beforeAll.length - 1; i >= 0; i -= 1) {
    const length = beforeAll[i].text.length;
    if (total + length > maxChars) break;
    total += length;
    before.unshift(beforeAll[i]);
  }

  const afterAll = lines.slice(endIndex + 1, endIndex + 1 + maxSegments);
  const after: PolishLine[] = [];
  total = 0;
  for (const line of afterAll) {
    const length = line.text.length;
    if (total + length > maxChars) break;
    total += length;
    after.push(line);
  }

  return { before, after };
}

/**
 * Latency scales with input size (reasoning tokens ≈ input chars), so a small
 * selection gets a proportionally small context window instead of the full
 * caps. Floors keep enough neighbourhood for homophone disambiguation.
 */
export function polishContextCharCap(selectionChars: number): number {
  return Math.min(TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS, Math.max(400, selectionChars * 2));
}

export function polishNoteCharCap(selectionChars: number): number {
  return Math.min(TRANSCRIPT_POLISH_MAX_NOTE_CHARS, Math.max(300, selectionChars));
}

const SYSTEM_RULES = `You are a transcript proofreader. You fix speech-to-text errors in the transcript segments you are given.

ABSOLUTE OUTPUT RULES:
- Return exactly one line per input segment, in the same order, each starting with the segment's ordinal and a vertical bar, e.g. "1| fixed text".
- Never merge, split, reorder, drop or add segments. The number of lines you return must equal the number of input segments.
- Output only those numbered lines. No preamble, no summary, no explanation, no markdown fences, no code blocks.
- If a segment needs no change, return it unchanged.

WHAT TO FIX:
- Wrong-character/homophone mistakes from the speech recogniser, mis-segmented words, wrong punctuation and sentence breaks.
- Names, product names and technical terms that the surrounding segments or the note make clear.
- Use the read-only context to disambiguate; fix the segment itself, not the context.

WHAT NOT TO DO:
- Do not summarise, shorten, expand or re-style. Keep the speaker's own wording, tone and level of formality.
- Do not delete filler words, repetitions or false starts unless they are clearly recogniser noise.
- Do not turn speech into bullet points, headings or written prose.
- Do not remove or rewrite the timestamp/speaker label if one appears in the input — the text after "ordinal|" is only the sentence.
- Do not translate. Keep the segment's original language.`;

/**
 * @param customDictionary user dictionary words (proper nouns to enforce)
 */
export function buildTranscriptPolishSystemPrompt(customDictionary?: string[]): string {
  const dictionary = buildDictionaryInstruction(customDictionary);
  return dictionary ? `${SYSTEM_RULES}\n\n${dictionary}` : SYSTEM_RULES;
}

function collapse(text: string): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** `mm:ss`, or `h:mm:ss` past an hour — same clock the transcript view shows. */
export function formatPolishClock(seconds?: number): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export interface PolishSegmentLike {
  id: string;
  text: string;
  source?: "mic" | "system";
  timestamp?: number;
}

/**
 * Label every segment the way the note-action input does: `[mm:ss] 你`.
 *
 * Deliberately keyed off `source` rather than the diarized speaker name: the
 * resolved names can still be placeholders ("发言人 1"), and a wrong name in the
 * prompt is worse than a neutral one.
 */
export function buildPolishLines(
  segments: PolishSegmentLike[],
  speakerLabels: { you: string; them: string }
): PolishLine[] {
  return segments.map((segment) => {
    const time = formatPolishClock(segment.timestamp);
    const speaker = segment.source === "mic" ? speakerLabels.you : speakerLabels.them;
    const label = `${time ? `[${time}] ` : ""}${speaker}`;
    return { id: segment.id, text: segment.text, label };
  });
}

function renderLine(ordinal: number | null, line: PolishLine, withColon = false): string {
  const label = collapse(line.label);
  const prefix = label ? `${label}${withColon ? ":" : ""} ` : "";
  return `${ordinal == null ? "" : `${ordinal}| `}${prefix}${collapse(line.text)}`;
}

export interface BuildTranscriptPolishMessagesInput {
  /** The segments to rewrite, in transcript order. */
  targets: PolishLine[];
  /** Read-only neighbours before the selection. */
  before?: PolishLine[];
  /** Read-only neighbours after the selection. */
  after?: PolishLine[];
  /** Note body used as terminology context only. */
  noteContent?: string | null;
  customDictionary?: string[];
  /** Per-request note cap; defaults to TRANSCRIPT_POLISH_MAX_NOTE_CHARS. */
  maxNoteChars?: number;
}

export function buildTranscriptPolishMessages({
  targets,
  before = [],
  after = [],
  noteContent,
  customDictionary,
  maxNoteChars,
}: BuildTranscriptPolishMessagesInput): TranscriptPolishMessages {
  const sections: string[] = [];

  sections.push(
    [
      `Rewrite ONLY the ${targets.length} numbered transcript segment(s) below.`,
      'Every line must keep its ordinal and the "|" separator.',
    ].join(" ")
  );
  sections.push(
    ["## Segments to rewrite", ...targets.map((line, i) => renderLine(i + 1, line, true))].join(
      "\n"
    )
  );

  const context = [...before, ...after];
  if (context.length > 0) {
    sections.push(
      [
        "## Read-only context (same meeting, not to be rewritten or returned)",
        ...context.map((line) => renderLine(null, line, true)),
      ].join("\n")
    );
  }

  const note = collapse(noteContent ?? "").slice(
    0,
    maxNoteChars ?? TRANSCRIPT_POLISH_MAX_NOTE_CHARS
  );
  if (note) {
    sections.push(
      [
        "## Note (read-only, for terminology and names only)",
        note,
        "Do not copy this note into the output and do not summarise it.",
      ].join("\n")
    );
  }

  sections.push(
    `Return exactly ${targets.length} line(s), ordinals 1..${targets.length}, in order.`
  );

  return {
    systemPrompt: buildTranscriptPolishSystemPrompt(customDictionary),
    userMessage: sections.join("\n\n"),
  };
}

// "1| text", "1 | text", "**1|** text", "[1] text", "1. text", "1、text"
const NUMBERED_LINE =
  /^\s*(?:[-*]\s*)?(?:\*\*)?\[?(\d{1,3})\]?(?:\*\*)?\s*[|｜.:：、)\]）-]\s*(.*)$/;

function dropEchoedLabel(text: string, label: string): string {
  const cleaned = collapse(text)
    .replace(/^\*\*|\*\*$/g, "")
    .trim();
  const normalized = collapse(label).replace(/[:：]\s*$/, "");
  if (!normalized) return cleaned;
  const candidates = [
    `${normalized}: `,
    `${normalized}：`,
    `${normalized}:`,
    `${normalized} `,
    normalized,
  ];
  for (const candidate of candidates) {
    if (cleaned.startsWith(candidate)) {
      return cleaned.slice(candidate.length).trim();
    }
  }
  return cleaned;
}

function stripFences(raw: string): string {
  return String(raw ?? "")
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?\s*```\s*$/, "");
}

/**
 * Parse the model's numbered response.
 *
 * Falls back to plain line order when the model ignored the ordinal protocol but
 * returned exactly one line per segment, so a small formatting slip does not
 * throw away a usable result. Anything else is reported as missing/unexpected
 * for the caller to surface.
 */
export function parseTranscriptPolishResponse(
  raw: string,
  targets: PolishLine[]
): TranscriptPolishParseResult {
  const body = stripFences(raw);
  const lines = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const entries: Array<{ index: number; text: string }> = [];
  const duplicated: number[] = [];
  const seen = new Set<number>();

  for (const line of lines) {
    const match = line.match(NUMBERED_LINE);
    if (!match) continue;
    const index = Number(match[1]);
    // A model that echoes prose can produce "2024. ..." — only accept ordinals
    // that exist in the selection.
    if (!Number.isInteger(index) || index < 1 || index > targets.length) continue;
    const text = dropEchoedLabel(match[2], targets[index - 1]?.label ?? "");
    if (!text) continue;
    if (seen.has(index)) {
      duplicated.push(index);
      continue;
    }
    seen.add(index);
    entries.push({ index, text });
  }

  let mode: TranscriptPolishParseResult["mode"] = "numbered";
  if (entries.length === 0 && lines.length === targets.length) {
    // No ordinals at all but a line per segment: trust document order.
    mode = "ordered-lines";
    lines.forEach((line, i) => {
      const text = dropEchoedLabel(line, targets[i]?.label ?? "");
      if (text) entries.push({ index: i + 1, text });
    });
  }

  entries.sort((a, b) => a.index - b.index);
  const missing: number[] = [];
  targets.forEach((_, i) => {
    if (!seen.has(i + 1) && !entries.some((entry) => entry.index === i + 1)) missing.push(i + 1);
  });

  return { entries, mode, missing, unexpected: [], duplicated };
}

/**
 * Match parsed lines back to the selected segments.
 *
 * Only segments that came back with a different, non-empty text become updates;
 * everything else (including segments the model left untouched) keeps its
 * current text, so a partial response can never blank a segment.
 */
export function buildTranscriptPolishUpdates(
  targets: PolishLine[],
  parsed: TranscriptPolishParseResult
): { updates: TranscriptPolishUpdate[]; missingIds: string[] } {
  const missingIds: string[] = [];
  const updates: TranscriptPolishUpdate[] = [];

  targets.forEach((target, i) => {
    const ordinal = i + 1;
    const entry = parsed.entries.find((candidate) => candidate.index === ordinal);
    if (!entry) {
      if (target.id) missingIds.push(target.id);
      return;
    }
    if (!target.id) return;
    const next = entry.text.trim();
    const previous = collapse(target.text);
    if (!next || next === previous) return;
    updates.push({ id: target.id, text: next, previousText: target.text });
  });

  return { updates, missingIds };
}

export interface PolishTargetSegment {
  id: string;
  text: string;
  editedByUser?: boolean;
  originalText?: string;
  learnedText?: string;
}

/**
 * Merge accepted rewrites into the transcript segments.
 *
 * Everything except `text` is preserved (timestamp, endTime, source, speaker and
 * the voiceprint fields), because the playhead, the diarization mapping and the
 * clip windows are all keyed off them. Segments that were not accepted — and
 * segments whose text did not actually change — are returned untouched, by
 * reference, so React can skip re-rendering them.
 *
 * `learnedText` is moved forward as well: it is the baseline the correction
 * learner diffs against, and leaving it behind would make the next manual edit
 * look like a full rewrite (which the learner discards).
 */
export function applyTranscriptPolishUpdates<T extends PolishTargetSegment>(
  segments: T[],
  updates: Array<{ id: string; text: string }>
): T[] {
  if (updates.length === 0) return segments;
  const byId = new Map(updates.map((update) => [update.id, update.text.trim()]));
  return segments.map((segment) => {
    const next = byId.get(segment.id);
    if (next === undefined || !next || next === segment.text) return segment;
    return {
      ...segment,
      text: next,
      editedByUser: true,
      originalText: segment.originalText ?? segment.text,
      learnedText: next,
    };
  });
}
