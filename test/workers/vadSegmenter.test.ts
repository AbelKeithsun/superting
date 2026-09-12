import assert from "node:assert/strict";
import test from "node:test";

import { segmentsFromProbabilities } from "../../src/workers/vadSegmenter.js";

// 10-sample windows @1000 Hz → 1 window = 10 ms; thresholds in windows:
// minSpeech 30ms → 3, minSilence 40ms → 4, maxSpeech 100ms → 10, pad 20 samples.
const OPTS = {
  windowSamples: 10,
  sampleRate: 1000,
  threshold: 0.5,
  minSpeechDurationMs: 30,
  minSilenceDurationMs: 40,
  maxSpeechDurationS: 0.1,
  speechPadMs: 20,
};

const probsOf = (pattern) => {
  const probs = [];
  for (const [count, value] of pattern) {
    for (let i = 0; i < count; i++) probs.push(value);
  }
  return probs;
};

test("detects a single speech region with padding and clamps to total length", () => {
  const probs = probsOf([
    [20, 0],
    [10, 1],
    [20, 0],
  ]);
  const segments = segmentsFromProbabilities(probs, { ...OPTS, totalSamples: 500 });
  assert.deepEqual(segments, [{ startSample: 180, endSample: 320 }]);
});

test("splits two utterances separated by a long enough pause", () => {
  const probs = probsOf([
    [20, 0],
    [10, 1],
    [5, 0],
    [10, 1],
    [21, 0],
  ]);
  const segments = segmentsFromProbabilities(probs, { ...OPTS, totalSamples: 710 });
  assert.deepEqual(segments, [
    { startSample: 180, endSample: 320 },
    { startSample: 330, endSample: 470 },
  ]);
});

test("discards blips shorter than minSpeechDurationMs", () => {
  const probs = probsOf([
    [30, 0],
    [2, 1],
    [8, 0],
    [30, 0],
  ]);
  const segments = segmentsFromProbabilities(probs, { ...OPTS, totalSamples: 700 });
  assert.deepEqual(segments, []);
});

test("force-splits speech longer than maxSpeechDurationS", () => {
  const probs = probsOf([
    [30, 1],
    [10, 0],
  ]);
  const segments = segmentsFromProbabilities(probs, { ...OPTS, totalSamples: 400 });
  assert.equal(segments.length, 3);
  assert.equal(segments[0].startSample, 0);
  assert.equal(segments[0].endSample, 120);
  assert.ok(segments[1].startSample < segments[1].endSample);
  assert.equal(segments[2].endSample, 320);
});

test("returns no segments for continuous silence", () => {
  const probs = probsOf([[100, 0]]);
  const segments = segmentsFromProbabilities(probs, { ...OPTS, totalSamples: 1000 });
  assert.deepEqual(segments, []);
});

test("handles empty probability arrays", () => {
  assert.deepEqual(segmentsFromProbabilities([], { ...OPTS, totalSamples: 0 }), []);
});
