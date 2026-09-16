const assert = require("node:assert/strict");
const test = require("node:test");

const { extractOpenAiResponseText } = require("../../src/services/ai/openaiResponseText.js");

test("extracts text from Responses API message output_text parts", () => {
  const response = {
    status: "completed",
    output: [
      { type: "reasoning", id: "r1", summary: [] },
      {
        type: "message",
        content: [
          { type: "output_text", text: "# 会议纪要\n第一段。" },
          { type: "output_text", text: "第二段。" },
        ],
      },
    ],
  };

  const result = extractOpenAiResponseText(response);

  assert.equal(result.isResponsesApi, true);
  assert.equal(result.text, "# 会议纪要\n第一段。\n第二段。");
  assert.equal(result.reasoningOnly, false);
  assert.equal(result.hasReasoningItem, true);
});

test("reasoning-only incomplete response yields empty text with diagnostics", () => {
  // This is the exact DeepSeek deepseek-flash failure shape: the whole output
  // budget was spent on reasoning, so there is no message item at all.
  const response = {
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "reasoning", id: "r1", content: [], summary: [] }],
  };

  const result = extractOpenAiResponseText(response);

  assert.equal(result.text, "");
  assert.equal(result.status, "incomplete");
  assert.equal(result.incompleteReason, "max_output_tokens");
  assert.equal(result.hasReasoningItem, true);
  assert.equal(result.reasoningOnly, true);
});

test("falls back to top-level output_text string", () => {
  const result = extractOpenAiResponseText({ output_text: "  hello  " });
  assert.equal(result.text, "hello");
});

test("extracts text from chat completions string content", () => {
  const response = {
    choices: [{ message: { role: "assistant", content: "整理后的内容" } }],
  };

  const result = extractOpenAiResponseText(response);

  assert.equal(result.isChatCompletions, true);
  assert.equal(result.text, "整理后的内容");
});

test("extracts text from chat completions array content parts", () => {
  const response = {
    choices: [{ message: { content: [{ type: "text", text: "part text" }] } }],
  };

  assert.equal(extractOpenAiResponseText(response).text, "part text");
});

test("chat completions with null content yields empty text", () => {
  const response = {
    choices: [{ message: { role: "assistant", content: null, reasoning_content: "…" } }],
  };

  const result = extractOpenAiResponseText(response);

  assert.equal(result.text, "");
  assert.equal(result.reasoningOnly, false);
});

test("unknown payload shape yields empty text without crashing", () => {
  const result = extractOpenAiResponseText({ error: { message: "boom" } });

  assert.equal(result.text, "");
  assert.equal(result.isResponsesApi, false);
  assert.equal(result.isChatCompletions, false);
  assert.equal(extractOpenAiResponseText(null).text, "");
  assert.equal(extractOpenAiResponseText(undefined).text, "");
});
