import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTranscriptPolishUpdates,
  buildTranscriptPolishMessages,
  buildTranscriptPolishSystemPrompt,
  buildTranscriptPolishUpdates,
  chunkPolishTargets,
  parseTranscriptPolishResponse,
  polishContextCharCap,
  polishNoteCharCap,
  slicePolishContext,
  TRANSCRIPT_POLISH_CHUNK_CHARS,
  TRANSCRIPT_POLISH_CHUNK_SEGMENTS,
  TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS,
  TRANSCRIPT_POLISH_MAX_NOTE_CHARS,
  type PolishLine,
} from "../../src/stores/transcriptPolishCore.ts";

const targets: PolishLine[] = [
  { id: "s1", text: "那个生僻字是在线的吗", label: "[00:05] 你" },
  { id: "s2", text: "对啊对啊", label: "[00:11] 对方" },
  { id: "s3", text: "考事报名系统什么时候上线", label: "[00:18] 你" },
];

test("system prompt forbids merging/summarising and carries the dictionary", () => {
  const withDict = buildTranscriptPolishSystemPrompt(["SuperTing", "考事报名"]);
  assert.match(withDict, /Never merge, split, reorder, drop or add segments/);
  assert.match(withDict, /Do not summarise, shorten, expand or re-style/);
  assert.ok(withDict.includes("SuperTing"));
  assert.ok(withDict.includes("考事报名"));

  const withoutDict = buildTranscriptPolishSystemPrompt([]);
  assert.equal(withoutDict.includes("Custom Dictionary"), false);
});

test("user message numbers every selected segment and keeps context read-only", () => {
  const { userMessage } = buildTranscriptPolishMessages({
    targets,
    before: [{ text: "会议开始了", label: "[00:01] 你" }],
    after: [{ text: "下周上线", label: "[00:25] 对方" }],
    noteContent: "考试报名系统上线准备会议",
  });

  assert.ok(userMessage.includes("1| [00:05] 你: 那个生僻字是在线的吗"));
  assert.ok(userMessage.includes("3| [00:18] 你: 考事报名系统什么时候上线"));
  assert.ok(userMessage.includes("Read-only context"));
  assert.ok(userMessage.includes("会议开始了"));
  assert.ok(userMessage.includes("考试报名系统上线准备会议"));
  assert.ok(userMessage.includes("Return exactly 3 line(s)"));
});

test("note context is capped so it can never dominate the request", () => {
  const { userMessage } = buildTranscriptPolishMessages({
    targets,
    noteContent: "备".repeat(TRANSCRIPT_POLISH_MAX_NOTE_CHARS + 5000),
  });
  const noteSection = userMessage.split("## Note")[1] ?? "";
  assert.ok(noteSection.length < TRANSCRIPT_POLISH_MAX_NOTE_CHARS + 200, `${noteSection.length}`);
});

test("parses the numbered protocol and strips an echoed label", () => {
  const raw = [
    "1| 那个生僻字在线的吗",
    "2| [00:11] 对方: 对啊对啊",
    "3| 考试报名系统什么时候上线",
  ].join("\n");
  const parsed = parseTranscriptPolishResponse(raw, targets);
  assert.equal(parsed.mode, "numbered");
  assert.deepEqual(parsed.missing, []);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.text),
    ["那个生僻字在线的吗", "对啊对啊", "考试报名系统什么时候上线"]
  );

  const { updates, missingIds } = buildTranscriptPolishUpdates(targets, parsed);
  // s2 came back unchanged, so only two segments are rewritten.
  assert.deepEqual(missingIds, []);
  assert.deepEqual(
    updates.map((update) => [update.id, update.text]),
    [
      ["s1", "那个生僻字在线的吗"],
      ["s3", "考试报名系统什么时候上线"],
    ]
  );
  assert.equal(updates[0].previousText, targets[0].text);
});

test("tolerates fenced output and other ordinal delimiters", () => {
  const raw = "```\n**1.** 第一句\n[2] 第二句\n3、第三句\n```";
  const parsed = parseTranscriptPolishResponse(raw, targets);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.index),
    [1, 2, 3]
  );
  assert.deepEqual(
    parsed.entries.map((entry) => entry.text),
    ["第一句", "第二句", "第三句"]
  );
});

test("reports missing segments instead of silently shifting them", () => {
  const parsed = parseTranscriptPolishResponse("1| 第一句\n3| 第三句", targets);
  assert.deepEqual(parsed.missing, [2]);
  const { updates, missingIds } = buildTranscriptPolishUpdates(targets, parsed);
  assert.deepEqual(missingIds, ["s2"]);
  assert.deepEqual(
    updates.map((update) => update.id),
    ["s1", "s3"]
  );
});

test("ignores prose that merely looks like a numbered line", () => {
  // "2024." must not be read as ordinal 2024, and ordinals beyond the selection
  // are dropped rather than applied to a wrong segment.
  const parsed = parseTranscriptPolishResponse("2024. 我们上线了\n9| 越界的行", targets);
  assert.deepEqual(parsed.entries, []);
  assert.deepEqual(parsed.missing, [1, 2, 3]);
});

test("falls back to document order when the model drops the ordinals", () => {
  const parsed = parseTranscriptPolishResponse("第一句\n第二句\n第三句", targets);
  assert.equal(parsed.mode, "ordered-lines");
  assert.deepEqual(parsed.missing, []);
  const { updates } = buildTranscriptPolishUpdates(targets, parsed);
  assert.equal(updates.length, 3);
});

test("the ordered-lines fallback refuses a mismatched line count", () => {
  const parsed = parseTranscriptPolishResponse("第一句\n第二句", targets);
  assert.deepEqual(parsed.entries, []);
  assert.deepEqual(parsed.missing, [1, 2, 3]);
});

test("an unchanged or empty segment never produces an update", () => {
  const parsed = parseTranscriptPolishResponse(
    "1| 那个生僻字是在线的吗\n2| \n3| 考试报名系统什么时候上线",
    targets
  );
  const { updates, missingIds } = buildTranscriptPolishUpdates(targets, parsed);
  // 1 came back identical → nothing to apply; 2 came back empty → reported as
  // missing instead of blanking the segment; 3 was genuinely rewritten.
  assert.deepEqual(missingIds, ["s2"]);
  assert.deepEqual(
    updates.map((update) => update.id),
    ["s3"]
  );
});

test("applying updates keeps every field the timeline and diarization rely on", () => {
  const segments = [
    {
      id: "s1",
      text: "考事报名",
      source: "mic" as const,
      timestamp: 12.5,
      endTime: 15.25,
      speaker: "speaker_1",
      speakerName: "张工",
      suggestedProfileId: 7,
    },
    { id: "s2", text: "对啊对啊", source: "system" as const, timestamp: 18 },
  ];

  const next = applyTranscriptPolishUpdates(segments, [
    { id: "s1", text: "考试报名" },
    { id: "missing", text: "不会有影响" },
    { id: "s2", text: "对啊对啊" },
  ]);

  assert.equal(next[0].text, "考试报名");
  assert.equal(next[0].timestamp, 12.5);
  assert.equal(next[0].endTime, 15.25);
  assert.equal(next[0].speaker, "speaker_1");
  assert.equal(next[0].speakerName, "张工");
  assert.equal(next[0].suggestedProfileId, 7);
  assert.equal(next[0].editedByUser, true);
  assert.equal(next[0].originalText, "考事报名");
  assert.equal(next[0].learnedText, "考试报名");

  // No-op update and unknown id: untouched, and by reference so React skips them.
  assert.equal(next[1], segments[1]);
  assert.deepEqual(applyTranscriptPolishUpdates(segments, []), segments);
});

test("applying updates never loses the first manual edit baseline", () => {
  const segments = [
    {
      id: "s1",
      text: "第二次改的",
      source: "mic" as const,
      originalText: "最初的识别结果",
      learnedText: "第一次改的",
      editedByUser: true,
    },
  ];
  const next = applyTranscriptPolishUpdates(segments, [{ id: "s1", text: "AI 润色后的" }]);
  assert.equal(next[0].originalText, "最初的识别结果");
  assert.equal(next[0].learnedText, "AI 润色后的");
  assert.equal(next[0].text, "AI 润色后的");
});

test("an update is trimmed and can never blank a segment", () => {
  const segments = [{ id: "s1", text: "有内容", source: "mic" as const }];
  assert.equal(applyTranscriptPolishUpdates(segments, [{ id: "s1", text: "   " }])[0], segments[0]);
  assert.equal(
    applyTranscriptPolishUpdates(segments, [{ id: "s1", text: "  润色后  " }])[0].text,
    "润色后"
  );
});

test("chunkPolishTargets keeps a small selection in one chunk", () => {
  assert.equal(chunkPolishTargets(targets).length, 1);
  assert.deepEqual(chunkPolishTargets([]), []);
});

test("chunkPolishTargets splits on segment count, then on characters", () => {
  const many = Array.from({ length: TRANSCRIPT_POLISH_CHUNK_SEGMENTS * 2 + 1 }, (_, i) => ({
    id: `s${i}`,
    text: "短句",
    label: "你",
  }));
  const byCount = chunkPolishTargets(many);
  assert.equal(byCount.length, 3);
  assert.equal(byCount[0].length, TRANSCRIPT_POLISH_CHUNK_SEGMENTS);
  assert.equal(byCount[2].length, 1);
  // Order is fully preserved across chunks.
  assert.deepEqual(byCount.flat().map((line) => line.id), many.map((line) => line.id));

  const long = Array.from({ length: 4 }, (_, i) => ({
    id: `l${i}`,
    text: "长".repeat(TRANSCRIPT_POLISH_CHUNK_CHARS - 100),
    label: "你",
  }));
  const byChars = chunkPolishTargets(long);
  assert.equal(byChars.length, 4, "each oversize segment starts a new chunk");
  assert.ok(byChars.every((chunk) => chunk.length === 1));
});

test("slicePolishContext keeps the closest neighbours on BOTH sides", () => {
  const lines: PolishLine[] = [
    { id: "far-before", text: "远".repeat(500), label: "你" },
    { id: "near-before", text: "近一点", label: "你" },
    { id: "t1", text: "目标一", label: "你" },
    { id: "t2", text: "目标二", label: "你" },
    { id: "near-after", text: "紧随其后的下文", label: "对方" },
    { id: "far-after", text: "远".repeat(500), label: "对方" },
  ];
  // A char cap that fits the near neighbours but not the far ones.
  const { before, after } = slicePolishContext(lines, 2, 3, 100, 5);
  assert.deepEqual(before.map((line) => line.id), ["near-before"]);
  assert.deepEqual(
    after.map((line) => line.id),
    ["near-after"],
    "after side must keep the CLOSEST lines, not the furthest"
  );

  // Segment cap applies before the char cap.
  const capped = slicePolishContext(lines, 2, 3, 99999, 1);
  assert.deepEqual(capped.before.map((line) => line.id), ["near-before"]);
  assert.deepEqual(capped.after.map((line) => line.id), ["near-after"]);

  // Edges: no neighbours available.
  assert.deepEqual(slicePolishContext(lines, 0, lines.length - 1).before, []);
  assert.deepEqual(slicePolishContext(lines, 0, lines.length - 1).after, []);
});

test("context and note caps scale with the selection, bounded by the maxima", () => {
  assert.equal(polishContextCharCap(50), 600, "floor keeps minimal disambiguation context");
  assert.equal(polishContextCharCap(100000), TRANSCRIPT_POLISH_MAX_CONTEXT_CHARS);
  assert.equal(polishNoteCharCap(50), 300);
  assert.equal(polishNoteCharCap(100000), TRANSCRIPT_POLISH_MAX_NOTE_CHARS);
});

test("maxNoteChars override tightens the note window per request", () => {
  const { userMessage } = buildTranscriptPolishMessages({
    targets,
    noteContent: "备".repeat(TRANSCRIPT_POLISH_MAX_NOTE_CHARS + 5000),
    maxNoteChars: 300,
  });
  const noteSection = userMessage.split("## Note")[1] ?? "";
  assert.ok(noteSection.length < 500, `${noteSection.length}`);
});
