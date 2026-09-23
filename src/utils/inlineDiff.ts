/**
 * Token-level inline diff for short transcript segments.
 *
 * Why tokens instead of raw characters: for CJK text one character *is* the
 * right unit, but for latin text a whole word (`quick`) reads far better than
 * a scatter of single-letter edits, and whitespace/punctuation should stay
 * attached to their neighbours. So the text is tokenised as
 * `[latin word] | [single CJK char] | [whitespace run] | [single punct char]`
 * and diffed with a classic LCS table.
 *
 * Dependency-free so the Node test runner can load it.
 */

export type InlineDiffType = "equal" | "del" | "ins";

export interface InlineDiffRun {
  type: InlineDiffType;
  text: string;
}

export interface CorrectionDraft {
  from: string;
  to: string;
}

const TOKEN = /[A-Za-z0-9_]+|[぀-ヿ㐀-䶿一-鿿豈-﫿]|\s+|./gsu;

/**
 * Above this many DP cells the LCS table is not worth its memory; fall back to
 * a prefix/suffix-only diff (middle becomes one del + one ins run). Transcript
 * segments are a few hundred tokens, so this only guards pathological input.
 */
const MAX_DP_CELLS = 9_000_000;

export function tokenizeInline(text: string): string[] {
  return String(text ?? "").match(TOKEN) ?? [];
}

function pushRun(runs: InlineDiffRun[], type: InlineDiffType, text: string): void {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.type === type) {
    last.text += text;
  } else {
    runs.push({ type, text });
  }
}

function lcsMiddleRuns(midA: string[], midB: string[]): InlineDiffRun[] {
  if (midA.length === 0 && midB.length === 0) return [];
  if (midA.length * midB.length > MAX_DP_CELLS) {
    const runs: InlineDiffRun[] = [];
    pushRun(runs, "del", midA.join(""));
    pushRun(runs, "ins", midB.join(""));
    return runs;
  }

  const rows = midA.length + 1;
  const cols = midB.length + 1;
  // dp[i*cols + j] = LCS length of midA[i..] and midB[j..]
  const dp = new Uint32Array(rows * cols);
  for (let i = midA.length - 1; i >= 0; i -= 1) {
    for (let j = midB.length - 1; j >= 0; j -= 1) {
      if (midA[i] === midB[j]) {
        dp[i * cols + j] = dp[(i + 1) * cols + (j + 1)] + 1;
      } else {
        dp[i * cols + j] = Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
      }
    }
  }

  const runs: InlineDiffRun[] = [];
  let i = 0;
  let j = 0;
  while (i < midA.length && j < midB.length) {
    if (midA[i] === midB[j]) {
      pushRun(runs, "equal", midA[i]);
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      pushRun(runs, "del", midA[i]);
      i += 1;
    } else {
      pushRun(runs, "ins", midB[j]);
      j += 1;
    }
  }
  while (i < midA.length) {
    pushRun(runs, "del", midA[i]);
    i += 1;
  }
  while (j < midB.length) {
    pushRun(runs, "ins", midB[j]);
    j += 1;
  }
  return runs;
}

/**
 * Diff two versions of one segment. The returned runs concatenate back to the
 * inputs: equal+del runs rebuild `oldText`, equal+ins runs rebuild `newText`.
 */
export function computeInlineDiff(oldText: string, newText: string): InlineDiffRun[] {
  const a = tokenizeInline(oldText);
  const b = tokenizeInline(newText);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const runs: InlineDiffRun[] = [];
  pushRun(runs, "equal", a.slice(0, prefix).join(""));
  for (const run of lcsMiddleRuns(
    a.slice(prefix, a.length - suffix),
    b.slice(prefix, b.length - suffix)
  )) {
    pushRun(runs, run.type, run.text);
  }
  pushRun(runs, "equal", a.slice(a.length - suffix).join(""));
  return runs;
}

/**
 * The (错 → 对) pair a changed run belongs to, for "save to dictionary":
 *
 * - a deleted run immediately followed by an inserted run (or vice versa) is a
 *   replacement → `{from, to}`;
 * - a lone insertion can still become a dictionary hotword → `{from: "", to}`;
 * - a lone deletion is recognised noise with no correction to learn → null.
 */
export function correctionDraftAt(runs: InlineDiffRun[], index: number): CorrectionDraft | null {
  const run = runs[index];
  if (!run) return null;
  if (run.type === "del") {
    const next = runs[index + 1];
    if (next && next.type === "ins") return { from: run.text, to: next.text };
    return null;
  }
  if (run.type === "ins") {
    const prev = runs[index - 1];
    if (prev && prev.type === "del") return { from: prev.text, to: run.text };
    return { from: "", to: run.text };
  }
  return null;
}
