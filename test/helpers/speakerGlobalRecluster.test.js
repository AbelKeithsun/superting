const test = require("node:test");
const assert = require("node:assert/strict");

const {
  absorbFragments,
  agglomerativeMerge,
  collectWindowClusters,
  reclusterWindowSpeakers,
} = require("../../src/helpers/speakerGlobalRecluster");
const { mergeWindowSegments } = require("../../src/helpers/diarizationAudioPolicy");

// Orthogonal-ish synthetic voices: A, B and one fragment voice near A.
const VA = [1, 0, 0, 0];
const VA2 = [0.98, 0.02, 0, 0];
const VB = [0, 1, 0, 0];
const VB2 = [0.02, 0.98, 0, 0];
const FRAG_A = [0.95, 0.05, 0, 0];

function window(index, startSeconds, segments) {
  return { index, startSeconds, segments };
}

test("collectWindowClusters inventories durations and keys by window index", () => {
  const results = [
    window(0, 0, [
      { start: 0, end: 10, speaker: "speaker_0" },
      { start: 10, end: 15, speaker: "speaker_1" },
    ]),
    window(1, 300, [{ start: 0, end: 20, speaker: "speaker_0" }]),
  ];
  const centroids = {
    "0|speaker_0": VA,
    "0|speaker_1": VB,
    "1|speaker_0": VA2,
  };
  const clusters = collectWindowClusters(results, centroids);
  assert.equal(clusters.length, 3);
  const byKey = Object.fromEntries(clusters.map((c) => [c.key, c]));
  assert.equal(byKey["0|speaker_0"].durationSec, 10);
  assert.equal(byKey["1|speaker_0"].durationSec, 20);
});

test("reclusterWindowSpeakers merges the same voice across windows, keeps voices apart", () => {
  const results = [
    window(0, 0, [
      { start: 0, end: 60, speaker: "speaker_0" },
      { start: 60, end: 90, speaker: "speaker_1" },
    ]),
    window(1, 300, [
      { start: 0, end: 50, speaker: "speaker_0" },
      { start: 50, end: 80, speaker: "speaker_3" },
    ]),
  ];
  const centroids = {
    "0|speaker_0": VA,
    "0|speaker_1": VB,
    "1|speaker_0": VA2,
    "1|speaker_3": VB2,
  };
  const out = reclusterWindowSpeakers(results, centroids, { threshold: 0.75, fragmentSeconds: 3 });
  assert.equal(out.groupCount, 2);
  // window-0 speaker_0 and window-1 speaker_0 (both voice A) share a label
  assert.equal(out.assignment.get("0|speaker_0"), out.assignment.get("1|speaker_0"));
  assert.equal(out.assignment.get("0|speaker_1"), out.assignment.get("1|speaker_3"));
  assert.notEqual(out.assignment.get("0|speaker_0"), out.assignment.get("0|speaker_1"));
  // speaker_0 is the most talkative group (voice A: 60+50s vs B: 30+30s)
  assert.equal(out.assignment.get("0|speaker_0"), "speaker_0");
});

test("fragments are absorbed into the closest anchor before merging", () => {
  const clusters = absorbFragments(
    [
      { key: "0|a", v: Float64Array.from(VA), durationSec: 40 },
      { key: "0|b", v: Float64Array.from(VB), durationSec: 30 },
      { key: "1|frag", v: Float64Array.from(FRAG_A), durationSec: 1 },
    ],
    3
  );
  assert.equal(clusters.length, 2);
  const anchor = clusters.find((c) => c.members.includes("1|frag"));
  assert.ok(anchor.members.includes("0|a"));
});

test("targetCount forces merging down to the pinned speaker count", () => {
  // Three well-separated voices, but the user pinned 2 speakers.
  const clusters = [
    { key: "0|a", v: Float64Array.from(VA), durationSec: 40, members: ["0|a"] },
    { key: "0|b", v: Float64Array.from(VB), durationSec: 30, members: ["0|b"] },
    { key: "1|c", v: Float64Array.from([0.7, 0.7, 0, 0]), durationSec: 20, members: ["1|c"] },
  ];
  const groups = agglomerativeMerge(clusters, { threshold: 0.99, targetCount: 2 });
  assert.equal(groups.length, 2);
  // The two closest voices (a and c) merged first.
  const big = groups.find((g) => g.members.length === 2);
  assert.ok(big.members.includes("0|a") && big.members.includes("1|c"));
});

test("mergeWindowSegments uses the voiceprint assignment instead of overlap", () => {
  // Two overlapping windows; overlap heuristic would mint a new speaker for
  // voice B in window 1 (B is silent in the overlap zone), the voiceprint
  // assignment keeps B's identity.
  const results = [
    {
      index: 0,
      startSeconds: 0,
      score: 1,
      segments: [
        { start: 0, end: 200, speaker: "speaker_0" }, // A talks through the overlap
        { start: 200, end: 250, speaker: "speaker_1" }, // B only after the overlap
      ],
    },
    {
      index: 1,
      startSeconds: 270,
      score: 1,
      segments: [
        { start: 0, end: 60, speaker: "speaker_0" },
        { start: 80, end: 140, speaker: "speaker_4" }, // B again, different local id
      ],
    },
  ];
  const assignment = new Map([
    ["0|speaker_0", "speaker_0"],
    ["0|speaker_1", "speaker_1"],
    ["1|speaker_0", "speaker_0"],
    ["1|speaker_4", "speaker_1"],
  ]);
  const merged = mergeWindowSegments(results, { speakerAssignment: assignment });
  const speakers = new Set(merged.map((s) => s.speaker));
  assert.deepEqual([...speakers].sort(), ["speaker_0", "speaker_1"]);
});

test("mergeWindowSegments without an assignment keeps the legacy overlap behavior", () => {
  const results = [
    {
      index: 0,
      startSeconds: 0,
      score: 1,
      segments: [{ start: 0, end: 100, speaker: "speaker_0" }],
    },
    {
      index: 1,
      startSeconds: 300,
      score: 1,
      segments: [{ start: 0, end: 100, speaker: "speaker_0" }],
    },
  ];
  const merged = mergeWindowSegments(results);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].speaker, "speaker_0");
  // No temporal overlap → the legacy path mints a new global speaker.
  assert.notEqual(merged[1].speaker, "speaker_0");
});

test("mergeWindowSegments assigns unembedded micro-clusters to the nearest speaker", () => {
  const results = [
    {
      index: 0,
      startSeconds: 0,
      score: 1,
      segments: [
        { start: 0, end: 50, speaker: "speaker_0" },
        { start: 55, end: 56, speaker: "speaker_9" }, // too short to embed
      ],
    },
  ];
  const assignment = new Map([["0|speaker_0", "speaker_0"]]);
  const merged = mergeWindowSegments(results, { speakerAssignment: assignment });
  assert.equal(merged.length, 2);
  assert.equal(merged[1].speaker, "speaker_0");
});
