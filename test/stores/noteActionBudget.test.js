const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeNoteActionMaxTokens,
  noteActionMaxTokensCeiling,
  NOTE_ACTION_MIN_MAX_TOKENS,
  NOTE_ACTION_MAX_MAX_TOKENS,
  NOTE_ACTION_CUSTOM_MAX_MAX_TOKENS,
  NOTE_ACTION_REQUEST_TIMEOUT_MS,
  NOTE_ACTION_TOKENS_PER_INPUT_CHAR,
  NOTE_ACTION_REASONING_TOKENS_PER_INPUT_CHAR,
} = require("../../src/stores/noteActionBudget.js");

test("short notes get the floor budget", () => {
  assert.equal(computeNoteActionMaxTokens(0), NOTE_ACTION_MIN_MAX_TOKENS);
  assert.equal(computeNoteActionMaxTokens(500), NOTE_ACTION_MIN_MAX_TOKENS);
  assert.equal(computeNoteActionMaxTokens(-3), NOTE_ACTION_MIN_MAX_TOKENS);
});

test("budget scales with input length and covers reasoning as well as the answer", () => {
  // 12.8k chars (a typical half-hour meeting transcript) must exceed the old
  // flat 4096 default — that cap was fully eaten by reasoning tokens.
  const budget = computeNoteActionMaxTokens(12830, NOTE_ACTION_CUSTOM_MAX_MAX_TOKENS);
  assert.ok(budget > 8192, `expected > 8192, got ${budget}`);
  // The answer alone needs ~1.2 tokens/char; hidden reasoning needs headroom on
  // top of that (deepseek-flash: ~0.3–0.7 tokens/char at its lowest effort).
  assert.equal(
    budget,
    Math.ceil(
      12830 * (NOTE_ACTION_TOKENS_PER_INPUT_CHAR + NOTE_ACTION_REASONING_TOKENS_PER_INPUT_CHAR)
    )
  );
  assert.ok(NOTE_ACTION_REASONING_TOKENS_PER_INPUT_CHAR > 0);
  // Providers with a known small output limit never get more than their ceiling.
  assert.equal(computeNoteActionMaxTokens(12830), NOTE_ACTION_MAX_MAX_TOKENS);
});

test("budget is capped for very long inputs", () => {
  assert.equal(computeNoteActionMaxTokens(1_000_000), NOTE_ACTION_MAX_MAX_TOKENS);
});

test("custom endpoints get a ceiling large enough for a full rewrite", () => {
  // Regression: 59,211-char transcript ("优化转录文本" on a ~1h meeting) needs
  // roughly 40k content + 20k reasoning tokens at the lowest effort, and ~56k
  // reasoning at the default effort. The old 24.5k ceiling could not hold the
  // answer by itself, so the Responses API returned `incomplete`
  // (`max_output_tokens`) with zero content.
  const ceiling = noteActionMaxTokensCeiling("custom");
  const budget = computeNoteActionMaxTokens(59211, ceiling);
  assert.equal(budget, Math.ceil(59211 * 2.2));
  assert.ok(budget >= 98304, `expected room for content + reasoning, got ${budget}`);
  assert.ok(ceiling >= 131072, `ceiling too tight: ${ceiling}`);
});

test("providers with a known small output limit stay in the safe window", () => {
  // Hosted OpenAI (gpt-4.1: 32k), local llama.cpp and Groq reject a cap above
  // their own limit, so their ceiling must not grow.
  for (const provider of ["openai", "local", "lan", "groq", "gemini", ""]) {
    assert.equal(noteActionMaxTokensCeiling(provider), NOTE_ACTION_MAX_MAX_TOKENS);
    assert.ok(
      computeNoteActionMaxTokens(1_000_000, noteActionMaxTokensCeiling(provider)) <=
        NOTE_ACTION_MAX_MAX_TOKENS
    );
  }
  assert.equal(noteActionMaxTokensCeiling("Custom"), NOTE_ACTION_CUSTOM_MAX_MAX_TOKENS);
  assert.equal(noteActionMaxTokensCeiling(undefined), NOTE_ACTION_MAX_MAX_TOKENS);
});

test("the request timeout outlasts a full-budget generation", () => {
  // Raising the budget on its own would just move the failure from "budget
  // exhausted" to "Request timed out after 90s": a 59k-character rewrite
  // measured ~170s. The provider default is 90s, so note actions must ask for
  // several times that.
  assert.ok(NOTE_ACTION_REQUEST_TIMEOUT_MS >= 300_000, `${NOTE_ACTION_REQUEST_TIMEOUT_MS}ms`);
  assert.ok(NOTE_ACTION_REQUEST_TIMEOUT_MS > 90_000);
});
