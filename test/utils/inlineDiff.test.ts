import assert from "node:assert/strict";
import test from "node:test";

import {
  computeInlineDiff,
  correctionDraftAt,
  tokenizeInline,
  type InlineDiffRun,
} from "../../src/utils/inlineDiff.ts";

function reconstruct(runs: InlineDiffRun[], types: string[]): string {
  return runs
    .filter((run) => types.includes(run.type))
    .map((run) => run.text)
    .join("");
}

function assertRoundTrip(oldText: string, newText: string, runs: InlineDiffRun[]): void {
  assert.equal(reconstruct(runs, ["equal", "del"]), oldText, "equal+del rebuilds old text");
  assert.equal(reconstruct(runs, ["equal", "ins"]), newText, "equal+ins rebuilds new text");
}

test("tokenize keeps latin words whole and splits CJK into single chars", () => {
  assert.deepEqual(tokenizeInline("the quick fox"), ["the", " ", "quick", " ", "fox"]);
  assert.deepEqual(tokenizeInline("我要考试"), ["我", "要", "考", "试"]);
  assert.deepEqual(tokenizeInline("v2.0 上线"), ["v2", ".", "0", " ", "上", "线"]);
});

test("identical texts produce a single equal run", () => {
  const runs = computeInlineDiff("今天天气不错", "今天天气不错");
  assert.deepEqual(runs, [{ type: "equal", text: "今天天气不错" }]);
  assertRoundTrip("今天天气不错", "今天天气不错", runs);
});

test("pure insertion and pure deletion", () => {
  // CJK: single-character granularity.
  const ins = computeInlineDiff("今天上线", "今天周五上线");
  assert.deepEqual(ins, [
    { type: "equal", text: "今天" },
    { type: "ins", text: "周五" },
    { type: "equal", text: "上线" },
  ]);
  assertRoundTrip("今天上线", "今天周五上线", ins);

  const del = computeInlineDiff("今天周五上线", "今天上线");
  assert.deepEqual(del, [
    { type: "equal", text: "今天" },
    { type: "del", text: "周五" },
    { type: "equal", text: "上线" },
  ]);
  assertRoundTrip("今天周五上线", "今天上线", del);

  // Latin: word granularity — a changed *letter* surfaces as a changed word.
  const wordIns = computeInlineDiff("release the build", "release the new build");
  assert.deepEqual(wordIns, [
    { type: "equal", text: "release the " },
    { type: "ins", text: "new " },
    { type: "equal", text: "build" },
  ]);
  assertRoundTrip("release the build", "release the new build", wordIns);
});

test("chinese replacement gives one del+ins pair with shared context", () => {
  const runs = computeInlineDiff("我要考事", "我要考试");
  assert.deepEqual(runs, [
    { type: "equal", text: "我要考" },
    { type: "del", text: "事" },
    { type: "ins", text: "试" },
  ]);
  assertRoundTrip("我要考事", "我要考试", runs);
});

test("english typo diffs at word granularity, not letters", () => {
  const runs = computeInlineDiff("the qick brown fox", "the quick brown fox");
  assert.deepEqual(runs, [
    { type: "equal", text: "the " },
    { type: "del", text: "qick" },
    { type: "ins", text: "quick" },
    { type: "equal", text: " brown fox" },
  ]);
  assertRoundTrip("the qick brown fox", "the quick brown fox", runs);
});

test("a multi-hunk rewrite round-trips and pairs each hunk", () => {
  const oldText = "那个生僻字是在线的吗，考事报名系统什么时候上线";
  const newText = "那个生僻字在线的吗，考试报名系统什么时候上线";
  const runs = computeInlineDiff(oldText, newText);
  assertRoundTrip(oldText, newText, runs);

  const pairs = runs
    .map((_, index) => correctionDraftAt(runs, index))
    .filter((draft) => draft && draft.from);
  assert.ok(pairs.some((pair) => pair.from === "事" && pair.to === "试"));
  // The dropped "是" is a lone deletion — noise, not a learnable correction.
  assert.ok(!pairs.some((pair) => pair.from === "是"));
});

test("correctionDraftAt: replacement pair reachable from both sides", () => {
  const runs = computeInlineDiff("我要考事", "我要考试");
  const delIndex = runs.findIndex((run) => run.type === "del");
  const insIndex = runs.findIndex((run) => run.type === "ins");
  assert.deepEqual(correctionDraftAt(runs, delIndex), { from: "事", to: "试" });
  assert.deepEqual(correctionDraftAt(runs, insIndex), { from: "事", to: "试" });
  assert.equal(correctionDraftAt(runs, 0), null, "equal runs are not clickable");
  assert.equal(correctionDraftAt(runs, 99), null);
});

test("correctionDraftAt: lone insertion becomes a hotword draft, lone deletion does not", () => {
  const ins = computeInlineDiff("我们下周上线", "我们下周五上线");
  const insIndex = ins.findIndex((run) => run.type === "ins");
  const draft = correctionDraftAt(ins, insIndex);
  assert.equal(draft?.from, "");
  assert.equal(draft?.to.trim(), "五");

  const del = computeInlineDiff("我们下周五上线", "我们下周上线");
  const delIndex = del.findIndex((run) => run.type === "del");
  assert.equal(correctionDraftAt(del, delIndex), null);
});

test("pathological sizes fall back to one del+ins middle without blowing up", () => {
  const oldText = `${"甲".repeat(4000)}X`;
  const newText = `${"乙".repeat(4000)}X`;
  const runs = computeInlineDiff(oldText, newText);
  assertRoundTrip(oldText, newText, runs);
  const types = runs.map((run) => run.type);
  assert.deepEqual(types, ["del", "ins", "equal"]);
});
