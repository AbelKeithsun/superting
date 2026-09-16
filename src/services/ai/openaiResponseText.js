/**
 * Pure extraction of assistant text from OpenAI-compatible Responses-API and
 * Chat-Completions payloads. No imports — safe to unit test under node --test.
 *
 * Why this exists: reasoning models (e.g. DeepSeek deepseek-flash/reasoner,
 * OpenAI o-series/gpt-5) can spend the ENTIRE output budget on hidden
 * reasoning and return `status: "incomplete"` with only a reasoning item and
 * no message at all. Callers must be able to distinguish "no text because the
 * budget was eaten by reasoning" from a genuinely empty reply — silently
 * treating both as "return the input" once caused note actions to overwrite
 * notes with the raw transcript.
 */

/**
 * @typedef {Object} OpenAiResponseExtraction
 * @property {string} text - extracted assistant text ("" when none)
 * @property {boolean} isResponsesApi - payload looks like the Responses API
 * @property {boolean} isChatCompletions - payload looks like Chat Completions
 * @property {string|null} status - Responses API status (e.g. "completed", "incomplete")
 * @property {string|null} incompleteReason - e.g. "max_output_tokens"
 * @property {boolean} hasReasoningItem - a reasoning item was present
 * @property {boolean} reasoningOnly - reasoning present but no message text
 */

/**
 * @param {any} response
 * @returns {OpenAiResponseExtraction}
 */
export function extractOpenAiResponseText(response) {
  const result = {
    text: "",
    isResponsesApi: Array.isArray(response?.output),
    isChatCompletions: Array.isArray(response?.choices),
    status: typeof response?.status === "string" ? response.status : null,
    incompleteReason:
      typeof response?.incomplete_details?.reason === "string"
        ? response.incomplete_details.reason
        : null,
    hasReasoningItem: false,
    reasoningOnly: false,
  };

  if (result.isResponsesApi) {
    const texts = [];
    let sawMessage = false;
    for (const item of response.output) {
      if (item?.type === "reasoning") {
        result.hasReasoningItem = true;
        continue;
      }
      if (item?.type !== "message" || !Array.isArray(item?.content)) continue;
      sawMessage = true;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part?.text === "string" && part.text.trim()) {
          texts.push(part.text.trim());
        }
      }
    }
    if (texts.length > 0) {
      result.text = texts.join("\n");
    }
    result.reasoningOnly = result.hasReasoningItem && !sawMessage && !result.text;
  }

  if (!result.text && typeof response?.output_text === "string") {
    result.text = response.output_text.trim();
    if (result.text) result.reasoningOnly = false;
  }

  if (!result.text && result.isChatCompletions) {
    for (const choice of response.choices) {
      const message = choice?.message ?? choice?.delta;
      const content = message?.content;

      if (typeof content === "string" && content.trim()) {
        result.text = content.trim();
        break;
      }

      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part?.text === "string" && part.text.trim()) {
            result.text = part.text.trim();
            break;
          }
        }
      }

      if (result.text) break;

      if (typeof choice?.text === "string" && choice.text.trim()) {
        result.text = choice.text.trim();
        break;
      }
    }
  }

  return result;
}
