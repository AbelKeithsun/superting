/**
 * Output-token budget for note actions (meeting minutes, note generation,
 * transcript optimization…).
 *
 * The cap is not a reservation — unused budget is not billed — but on reasoning
 * models it is *shared* with hidden thinking, so two things have to fit inside
 * it:
 *
 *   1. the visible answer. "优化转录文本" re-emits the whole transcript, so the
 *      answer alone costs roughly as many tokens as the input;
 *   2. hidden reasoning. Measured on deepseek-flash at its lowest effort
 *      (Responses API, `reasoning.effort: "low"`): ~0.3–0.7 reasoning tokens
 *      per input character before the first visible token.
 *
 * The old flat 4096 default — and even the later 8k–24.5k window scaled at
 * 1.2 tokens/char — only covered item 1 for short inputs. A 59k-character
 * transcript needs roughly 40k content + 20k reasoning tokens, so the response
 * came back `status: "incomplete"` with `incomplete_details.reason:
 * "max_output_tokens"`, zero content, and the note action failed with
 * "raise the output token budget" — advice the user had no way to act on.
 *
 * Scale with the input and add an explicit reasoning allowance instead.
 */

/** Visible-answer tokens per input character (a rewrite emits ~the input). */
export const NOTE_ACTION_TOKENS_PER_INPUT_CHAR = 1.2;
/** Hidden-reasoning tokens per input character (low effort, measured). */
export const NOTE_ACTION_REASONING_TOKENS_PER_INPUT_CHAR = 1;

export const NOTE_ACTION_MIN_MAX_TOKENS = 8192;

/**
 * Ceiling for providers with a known, comparatively small output limit
 * (hosted OpenAI: the gpt-4.1 family caps out at 32k and the Responses API
 * rejects a larger `max_output_tokens`; local llama.cpp: bounded by the loaded
 * context; Groq: per-model `max_completion_tokens`). Asking for more than the
 * model allows turns a truncated answer into a hard 400, so stay in the window
 * that was already safe.
 */
export const NOTE_ACTION_MAX_MAX_TOKENS = 24576;

/**
 * Ceiling for custom / self-hosted OpenAI-compatible bases. We have no limit
 * metadata for them, and the big ones are generous — DeepSeek reports
 * `max_output_tokens: 393216` for deepseek-flash — so allow a full rewrite of a
 * long transcript instead of truncating it. Sized for the worst case measured:
 * a 59k-character transcript at the *default* reasoning effort spends ~56k
 * tokens thinking plus ~40k on the answer.
 */
export const NOTE_ACTION_CUSTOM_MAX_MAX_TOKENS = 131072;

/**
 * Wall-clock cap for a single note-action request (10 minutes).
 *
 * The provider default is 90s, which is fine for dictation cleanup but aborts a
 * long note action mid-generation: raising the budget alone is not enough, as a
 * 59k-character 优化转录文本 run measured ~170s / ~62k output tokens (32.6k of
 * them hidden reasoning) on deepseek-flash at low effort. Timeouts are marked
 * non-retriable, so this is also the worst-case wait for one attempt.
 */
export const NOTE_ACTION_REQUEST_TIMEOUT_MS = 600000;

/**
 * Output ceiling to use for a resolved scope provider.
 *
 * @param {string} [provider] - resolved provider id (e.g. "custom", "openai")
 * @returns {number} max output tokens to allow for this provider
 */
export function noteActionMaxTokensCeiling(provider) {
  const normalized = String(provider ?? "")
    .trim()
    .toLowerCase();
  if (normalized === "custom") {
    return NOTE_ACTION_CUSTOM_MAX_MAX_TOKENS;
  }
  return NOTE_ACTION_MAX_MAX_TOKENS;
}

/**
 * @param {number} inputLength - character length of the action input
 * @param {number} [ceiling] - provider ceiling, see noteActionMaxTokensCeiling
 * @returns {number} max output tokens to request
 */
export function computeNoteActionMaxTokens(
  inputLength,
  ceiling = NOTE_ACTION_MAX_MAX_TOKENS
) {
  const perInputChar =
    NOTE_ACTION_TOKENS_PER_INPUT_CHAR + NOTE_ACTION_REASONING_TOKENS_PER_INPUT_CHAR;
  const scaled = Math.ceil(Math.max(0, inputLength) * perInputChar);
  return Math.max(NOTE_ACTION_MIN_MAX_TOKENS, Math.min(ceiling, scaled));
}
