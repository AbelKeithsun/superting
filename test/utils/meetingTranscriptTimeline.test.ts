import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranscriptTimelineOffsetSeconds,
  offsetAppendedTranscriptSegments,
  repairLegacyCentisecondTimestamps,
  resolveNoteActionTranscript,
  resolveTranscriptTimestampUnit,
  timelineSecondsForUnit,
  toTranscriptTimelineSeconds,
  transcriptTimestampToSeconds,
} from "../../src/utils/meetingTranscriptTimeline.ts";

test("resolved action transcript uses persisted transcript after recording stops", () => {
  const result = resolveNoteActionTranscript({
    isActiveNoteRecording: false,
    realtimeTranscript: "last short recording",
    persistedTranscript: '[{"text":"full transcript"}]',
  });

  assert.equal(result, '[{"text":"full transcript"}]');
});

test("resolved action transcript uses realtime transcript only for active recording", () => {
  const result = resolveNoteActionTranscript({
    isActiveNoteRecording: true,
    realtimeTranscript: "live transcript",
    persistedTranscript: '[{"text":"old transcript"}]',
  });

  assert.equal(result, "live transcript");
});

test("offsets appended recording segments after the existing timeline", () => {
  const seedSegments = [{ id: "old-1", text: "old", source: "system" as const, timestamp: 162 }];
  const recordingStartedAt = 1_800_000_000_000;
  const segments = [
    ...seedSegments,
    {
      id: "new-1",
      text: "new one",
      source: "system" as const,
      timestamp: recordingStartedAt + 6000,
    },
    {
      id: "new-2",
      text: "new two",
      source: "system" as const,
      timestamp: recordingStartedAt + 12000,
    },
  ];

  const result = offsetAppendedTranscriptSegments(segments, seedSegments, recordingStartedAt);

  assert.equal(result[0].timestamp, 162);
  assert.equal(result[1].timestamp, 163);
  assert.equal(result[2].timestamp, 169);
});

test("resumed timeline offset continues from the previous session end", () => {
  assert.equal(getTranscriptTimelineOffsetSeconds([]), 0);
  assert.equal(
    getTranscriptTimelineOffsetSeconds([
      { id: "a", text: "a", source: "system" as const, timestamp: 162 },
    ]),
    163
  );
});

test("live epoch timestamps land after the previous session instead of restarting at 0", () => {
  const recordingStartedAt = 1_800_000_000_000;
  const timelineOffsetSeconds = 163; // previous session ended at 162s

  assert.equal(
    toTranscriptTimelineSeconds(
      recordingStartedAt + 6000,
      recordingStartedAt,
      timelineOffsetSeconds,
      "funasr"
    ),
    169
  );
  assert.equal(
    toTranscriptTimelineSeconds(undefined, recordingStartedAt, timelineOffsetSeconds),
    undefined
  );
});

test("a provider that reports timeline seconds also gets the resumed-session offset", () => {
  const recordingStartedAt = 1_800_000_000_000;
  const timelineOffsetSeconds = 163;

  // A resumed session whose provider stamps its own clock used to skip the
  // offset and restart at 0 while the earlier lines stayed at 162s.
  assert.equal(toTranscriptTimelineSeconds(12, recordingStartedAt, timelineOffsetSeconds), 175);
  // Unknown providers are placed by domain: below the threshold = timeline seconds.
  assert.equal(resolveTranscriptTimestampUnit(null, 12), "seconds");
  assert.equal(resolveTranscriptTimestampUnit("some-new-realtime", 12), "epoch-ms");
  assert.equal(resolveTranscriptTimestampUnit("funasr", 12), "epoch-ms");
  assert.equal(resolveTranscriptTimestampUnit(null, recordingStartedAt + 12), "epoch-ms");
});

test("a provider that reports centiseconds is converted once, at ingest", () => {
  // No provider wired today reports centiseconds; the conversion lives at ingest
  // so a legacy/self-hosted engine only needs an entry in
  // PROVIDER_TIMESTAMP_UNITS to have its stamps normalised in one place.
  assert.equal(transcriptTimestampToSeconds(18_018, "centiseconds"), 180.18);
  assert.equal(timelineSecondsForUnit(18_018, "centiseconds", null, 163), 343.18);
  // An unknown provider falls back to the value's domain — never to /100.
  assert.equal(resolveTranscriptTimestampUnit("legacy-cs-provider", 18_018), "seconds");
});

test("legacy centisecond transcripts are repaired at ingest, not at render time", () => {
  const segments = [
    { id: "old-1", text: "开场", source: "system" as const, timestamp: 18_018, endTime: 25_000 },
  ];

  const repaired = repairLegacyCentisecondTimestamps(segments, 300);
  assert.equal(repaired[0].timestamp, 180.18);
  assert.equal(repaired[0].endTime, 250);
  // A repairable transcript is repaired once; running again is a no-op.
  assert.deepEqual(repairLegacyCentisecondTimestamps(repaired, 300), repaired);
  // Without the note's audio duration there is no evidence — leave it alone.
  assert.deepEqual(repairLegacyCentisecondTimestamps(segments, null), segments);
  // Values that already fit the note timeline are never rescaled.
  const timelineSeconds = [{ id: "s", text: "x", source: "system" as const, timestamp: 240 }];
  assert.deepEqual(repairLegacyCentisecondTimestamps(timelineSeconds, 300), timelineSeconds);
});

test("persisting a resumed session is idempotent once live segments carry the offset", () => {
  const recordingStartedAt = 1_800_000_000_000;
  const seedSegments = [{ id: "old-1", text: "old", source: "system" as const, timestamp: 162 }];
  const timelineOffsetSeconds = getTranscriptTimelineOffsetSeconds(seedSegments);
  const segments = [
    ...seedSegments,
    {
      id: "new-1",
      text: "new",
      source: "system" as const,
      timestamp: toTranscriptTimelineSeconds(
        recordingStartedAt + 6000,
        recordingStartedAt,
        timelineOffsetSeconds
      ),
    },
  ];

  const first = offsetAppendedTranscriptSegments(segments, seedSegments, recordingStartedAt);
  const second = offsetAppendedTranscriptSegments(
    first,
    seedSegments.slice(0, 1),
    recordingStartedAt
  );

  assert.equal(first[1].timestamp, 169);
  // The 30s autosave re-runs the offset against an updated seed; the anchor
  // must not drift, otherwise resumed lines march away from the audio.
  assert.equal(second[1].timestamp, 169);
});
