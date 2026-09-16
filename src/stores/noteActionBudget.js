/**
 * Output-token budget for note actions (meeting minutes, note generation…).
 *
 * The provider default (4096) is not enough for note actions: reasoning
 * models burn hidden thinking tokens before producing any visible content
 * (measured on a 12.8k-char meeting transcript with deepseek-flash: ~9k
 * reasoning tokens at low effort + ~3k content tokens), so a 4096 cap ends
 * with `status: "incomplete"` and zero usable output. Scale the budget with
 * the input size instead. max_output_tokens is a cap, not a reservation —
 * unused budget is not billed.
 */

export const NOTE_ACTION_MIN_MAX_TOKENS = 8192;
export const NOTE_ACTION_MAX_MAX_TOKENS = 24576;
export const NOTE_ACTION_TOKENS_PER_INPUT_CHAR = 1.2;

/**
 * @param {number} inputLength - character length of the action input
 * @returns {number} max output tokens to request
 */
export function computeNoteActionMaxTokens(inputLength) {
  const scaled = Math.ceil(Math.max(0, inputLength) * NOTE_ACTION_TOKENS_PER_INPUT_CHAR);
  return Math.max(NOTE_ACTION_MIN_MAX_TOKENS, Math.min(NOTE_ACTION_MAX_MAX_TOKENS, scaled));
}
