import assert from "node:assert/strict";
import test from "node:test";

import {
  getTranscriptTimelineOffsetSeconds,
  offsetAppendedTranscriptSegments,
  resolveNoteActionTranscript,
  toTranscriptTimelineSeconds,
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
    toTranscriptTimelineSeconds(recordingStartedAt + 6000, recordingStartedAt, timelineOffsetSeconds),
    169
  );
  // Already-relative timestamps must pass through untouched.
  assert.equal(toTranscriptTimelineSeconds(12, recordingStartedAt, timelineOffsetSeconds), 12);
  assert.equal(toTranscriptTimelineSeconds(undefined, recordingStartedAt, timelineOffsetSeconds), undefined);
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
