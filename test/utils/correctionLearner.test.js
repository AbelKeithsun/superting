const test = require("node:test");
const assert = require("node:assert/strict");

const { extractReplacementCorrection, analyzeCorrection } = require("../../src/utils/correctionLearner.js");

test("extractReplacementCorrection learns a valid replacement word", () => {
  assert.deepEqual(
    extractReplacementCorrection({
      findText: "super ting",
      replacementText: "SuperTing",
      replacementCount: 1,
      existingDictionary: [],
    }),
    ["SuperTing"]
  );
});

test("extractReplacementCorrection skips invalid replacement candidates", () => {
  const cases = [
    { findText: "", replacementText: "SuperTing", replacementCount: 1 },
    { findText: "SuperTing", replacementText: "", replacementCount: 1 },
    { findText: "SuperTing", replacementText: "SuperTing", replacementCount: 1 },
    { findText: "AI", replacementText: "ML", replacementCount: 1 },
    { findText: "alpha", replacementText: "CompletelyDifferent", replacementCount: 1 },
    { findText: "super ting", replacementText: "SuperTing", replacementCount: 0 },
  ];

  for (const input of cases) {
    assert.deepEqual(extractReplacementCorrection({ ...input, existingDictionary: [] }), []);
  }
});

test("extractReplacementCorrection skips existing dictionary entries case-insensitively", () => {
  assert.deepEqual(
    extractReplacementCorrection({
      findText: "super ting",
      replacementText: "SuperTing",
      replacementCount: 3,
      existingDictionary: ["superting"],
    }),
    []
  );
});

test("analyzeCorrection reports a learnable CJK substitution pair", () => {
  const result = analyzeCorrection({
    originalText: "大家好今天我们来讨论一下这个问题",
    editedText: "各位好今天我们讨论这个问题",
    existingDictionary: [],
  });
  assert.equal(result.reason, "learned-candidate");
  assert.deepEqual(result.pairs, [{ from: "大家", to: "各位" }]);
});

test("analyzeCorrection explains every edit that yields no pair", () => {
  const cases = [
    ["我下午三点开个会", "我下午三点开个短会", "insertion-only"],
    ["这个季度营收增长", "这个季度营收", "deletion-only"],
    ["会议", "会", "deletion-only"],
    ["说话人识别", "说话人辨识", "mixed-insert-delete"],
    ["今天下雨了", "明天天晴了", "rewrite"],
    ["hello world", "hello brave new world", "insertion-only"],
    ["ah", "ha", "too-short"],
    ["同上", "同上", "no-change"],
  ];
  for (const [originalText, editedText, reason] of cases) {
    const result = analyzeCorrection({ originalText, editedText, existingDictionary: [] });
    assert.deepEqual(result.pairs, [], `${originalText} → ${editedText}`);
    assert.equal(result.reason, reason, `${originalText} → ${editedText}`);
  }
});

test("analyzeCorrection skips corrections already in the dictionary", () => {
  const result = analyzeCorrection({
    originalText: "entibus",
    editedText: "EntVerse",
    existingDictionary: ["EntVerse"],
  });
  assert.deepEqual(result.pairs, []);
  assert.equal(result.reason, "already-in-dictionary");
});

test("analyzeCorrection keeps returning pairs compatible with extractCorrectionPairs", () => {
  const args = { originalText: "the quick brown fox", editedText: "the quick brown fix" };
  assert.deepEqual(analyzeCorrection({ ...args, existingDictionary: [] }).pairs, [
    { from: "fox", to: "fix" },
  ]);
});
