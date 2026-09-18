import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTranscriptTimestamp,
  getElapsedRecordingSeconds,
  getPlaybackActiveSegmentId,
  getRelativeTranscriptSeconds,
  getTranscriptSeekSeconds,
  shouldApplyMediaSeekNow,
} from "../../src/utils/recordingTime.ts";

test("recording elapsed seconds are derived from the session start timestamp", () => {
  assert.equal(getElapsedRecordingSeconds(null, 71_000), 0);
  assert.equal(getElapsedRecordingSeconds(10_000, 71_499), 61);
  assert.equal(getElapsedRecordingSeconds(72_000, 71_000), 0);
});

test("transcript timestamps render relative clock labels", () => {
  assert.equal(formatTranscriptTimestamp(13.4), "00:13");
  assert.equal(formatTranscriptTimestamp(3661), "01:01:01");
  assert.equal(formatTranscriptTimestamp(1_700_000_013_400, 1_700_000_000_000), "00:13");
  assert.equal(formatTranscriptTimestamp(undefined), "");
});

test("epoch transcript timestamps normalize to relative seconds", () => {
  assert.equal(getRelativeTranscriptSeconds(1_700_000_013_400, 1_700_000_000_000), 13.4);
  assert.equal(getRelativeTranscriptSeconds(42.5, 1_700_000_000_000), 42.5);
  assert.equal(getRelativeTranscriptSeconds(undefined, 1_700_000_000_000), undefined);
});

test("timeline seconds render as stored without guessing a unit", () => {
  // Regression: a resumed session's timeline runs past the duration of the
  // saved audio (the note's audio files only cover the sessions that already
  // stopped). The display used to treat such a value as centiseconds and divide
  // it by 100, so a 33s line rendered 00:00 and then crawled 00:01 / 00:02 while
  // the recording kept running. Units are normalised at ingest instead.
  assert.equal(formatTranscriptTimestamp(33), "00:33");
  assert.equal(formatTranscriptTimestamp(101), "01:41");
  assert.equal(getTranscriptSeekSeconds(101), 101);
  assert.equal(getTranscriptSeekSeconds(18_018), 18_018);
});

test("epoch transcript timestamps seek relative to the recording start", () => {
  assert.equal(getTranscriptSeekSeconds(1_700_000_240_000, 1_700_000_000_000), 240);
});

test("playback active segment follows the current audio time", () => {
  const segments = [
    { id: "intro", timestamp: 0 },
    { id: "middle", timestamp: 30.12 },
    { id: "next", timestamp: 31.16 },
    { id: "final", timestamp: 32.19 },
  ];

  assert.equal(getPlaybackActiveSegmentId(0, segments), "intro");
  assert.equal(getPlaybackActiveSegmentId(30.12, segments), "middle");
  assert.equal(getPlaybackActiveSegmentId(30.9, segments), "middle");
  assert.equal(getPlaybackActiveSegmentId(31.16, segments), "next");
  assert.equal(getPlaybackActiveSegmentId(120, segments), "final");
});

test("playback active segment ignores invalid timestamps", () => {
  const segments = [{ id: "missing" }, { id: "valid", timestamp: 12 }];

  assert.equal(getPlaybackActiveSegmentId(5, segments), null);
  assert.equal(getPlaybackActiveSegmentId(12.5, segments), "valid");
  assert.equal(getPlaybackActiveSegmentId(Number.NaN, segments), null);
});

test("media seek waits until metadata is available after a source is assigned", () => {
  assert.equal(shouldApplyMediaSeekNow({ src: "", readyState: 0 }), false);
  assert.equal(shouldApplyMediaSeekNow({ src: "ow-audio://note/1", readyState: 0 }), false);
  assert.equal(shouldApplyMediaSeekNow({ src: "ow-audio://note/1", readyState: 1 }), true);
});
