const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeNoteActionMaxTokens,
  NOTE_ACTION_MIN_MAX_TOKENS,
  NOTE_ACTION_MAX_MAX_TOKENS,
} = require("../../src/stores/noteActionBudget.js");

test("short notes get the floor budget", () => {
  assert.equal(computeNoteActionMaxTokens(0), NOTE_ACTION_MIN_MAX_TOKENS);
  assert.equal(computeNoteActionMaxTokens(500), NOTE_ACTION_MIN_MAX_TOKENS);
  assert.equal(computeNoteActionMaxTokens(-3), NOTE_ACTION_MIN_MAX_TOKENS);
});

test("budget scales with input length", () => {
  // 12.8k chars (a typical half-hour meeting transcript) must exceed the old
  // flat 4096 default — that cap was fully eaten by reasoning tokens.
  const budget = computeNoteActionMaxTokens(12830);
  assert.ok(budget > 8192, `expected > 8192, got ${budget}`);
  assert.ok(budget <= NOTE_ACTION_MAX_MAX_TOKENS);
  assert.equal(budget, Math.ceil(12830 * 1.2));
});

test("budget is capped for very long inputs", () => {
  assert.equal(computeNoteActionMaxTokens(1_000_000), NOTE_ACTION_MAX_MAX_TOKENS);
});
