const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cosineSimilarity,
  mergeSimilarSpeakerClusters,
} = require("../../src/helpers/speakerClusterMerge.js");

const near = (scale) => [scale, 0, 0, 0];
const other = [0, 1, 0, 0];

// One long anchor (speaker_0, 100s), one medium anchor (speaker_3, 60s) and two
// short fragments that belong to the long anchor.
const segments = [
  { speaker: "speaker_0", start: 0, end: 100 },
  { speaker: "speaker_1", start: 100, end: 105 },
  { speaker: "speaker_2", start: 105, end: 112 },
  { speaker: "speaker_3", start: 112, end: 172 },
];

test("cosine similarity is scale invariant and safe on bad input", () => {
  assert.equal(cosineSimilarity(near(1), near(5)), 1);
  assert.equal(cosineSimilarity(near(1), other), 0);
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0);
  assert.equal(cosineSimilarity(null, other), 0);
});

test("short fragments are absorbed into their best-matching longer speaker", () => {
  const result = mergeSimilarSpeakerClusters(
    segments,
    { speaker_0: near(1), speaker_1: near(1.1), speaker_2: near(1.2), speaker_3: other },
    { threshold: 0.8, maxFragmentSeconds: 20 }
  );

  assert.equal(result.mergeCount, 2);
  assert.deepEqual(
    result.segments.map((segment) => segment.speaker),
    ["speaker_0", "speaker_0", "speaker_0", "speaker_3"]
  );
  assert.deepEqual(Object.keys(result.embeddings).sort(), ["speaker_0", "speaker_3"]);
  assert.deepEqual(
    result.groups.map((group) => [...group].sort()),
    [["speaker_0", "speaker_1", "speaker_2"], ["speaker_3"]]
  );
});

test("substantial speakers never merge with each other", () => {
  const result = mergeSimilarSpeakerClusters(
    segments,
    { speaker_0: near(1), speaker_1: near(1), speaker_2: near(1), speaker_3: near(1) },
    { threshold: 0.8, maxFragmentSeconds: 20 }
  );

  // Only the two short clusters are fragments; the 100s and 60s speakers stay.
  assert.equal(result.mergeCount, 2);
  assert.deepEqual(
    [...new Set(result.segments.map((segment) => segment.speaker))].sort(),
    ["speaker_0", "speaker_3"]
  );
});

test("a fragment with no close speaker is left alone", () => {
  const result = mergeSimilarSpeakerClusters(
    segments,
    { speaker_0: near(1), speaker_1: other, speaker_2: [0, 0, 0, 1], speaker_3: [0, 0, 1, 0] },
    { threshold: 0.8, maxFragmentSeconds: 20 }
  );

  assert.equal(result.mergeCount, 0);
  assert.equal(result.segments, segments);
});

test("an invalid or missing threshold leaves the clusters untouched", () => {
  const result = mergeSimilarSpeakerClusters(
    segments,
    { speaker_0: near(1), speaker_1: near(1.1) },
    { threshold: 0 }
  );

  assert.equal(result.mergeCount, 0);
  assert.equal(result.segments, segments);
});

test("everything below the fragment floor is treated as one long take", () => {
  // No cluster is long enough to anchor a merge, so nothing should change even
  // though all voiceprints look alike.
  const short = [
    { speaker: "a", start: 0, end: 5 },
    { speaker: "b", start: 5, end: 10 },
  ];
  const result = mergeSimilarSpeakerClusters(short, { a: near(1), b: near(1) }, {
    threshold: 0.8,
    maxFragmentSeconds: 20,
  });

  assert.equal(result.mergeCount, 0);
  assert.equal(result.segments, short);
});
