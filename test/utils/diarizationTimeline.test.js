const test = require("node:test");
const assert = require("node:assert/strict");

const {
  dbTimestampMs,
  noteAudioSecondsForTimestamp,
  noteTimelineStartForAudio,
  restoreTranscriptTimestamps,
  toAudioRelativeSegments,
  toNoteTimelineSegments,
} = require("../../src/utils/diarizationTimeline.js");

test("DB timestamps are read as UTC whether or not they carry a zone marker", () => {
  assert.equal(dbTimestampMs("2026-09-18 01:02:14"), Date.UTC(2026, 8, 18, 1, 2, 14));
  assert.equal(dbTimestampMs("2026-09-18T01:02:14.718Z"), Date.UTC(2026, 8, 18, 1, 2, 14, 718));
  assert.equal(dbTimestampMs(null), null);
  assert.equal(dbTimestampMs("not a date"), null);
});

test("absolute stamps are rebased on the diarized audio file's own start", () => {
  const audioStartMs = 1_800_000_000_000;
  const segments = [
    { id: "a", timestamp: audioStartMs + 4_000, endTime: audioStartMs + 9_500 },
    { id: "b", timestamp: audioStartMs + 12_000 },
  ];

  const matching = toAudioRelativeSegments(segments, { audioStartMs });

  assert.equal(matching[0].timestamp, 4);
  assert.equal(matching[0].endTime, 9.5);
  assert.equal(matching[1].timestamp, 12);
  // The originals are never mutated: they are what gets persisted later.
  assert.equal(segments[0].timestamp, audioStartMs + 4_000);
});

test("without an anchor the segments pass through untouched", () => {
  const segments = [{ id: "a", timestamp: 1_800_000_004_000, endTime: 1_800_000_009_500 }];
  assert.deepEqual(toAudioRelativeSegments(segments, {}), segments);
  assert.deepEqual(
    toAudioRelativeSegments(segments, { audioStartMs: null, baseNoteSeconds: 0 }),
    segments
  );
});

test("timeline seconds are shifted by the part of the timeline that precedes the file", () => {
  const segments = [{ id: "a", timestamp: 800, endTime: 806 }];
  const matching = toAudioRelativeSegments(segments, { baseNoteSeconds: 766 });

  assert.equal(matching[0].timestamp, 34);
  assert.equal(matching[0].endTime, 40);
  // Never negative, even if a segment predates the anchor.
  assert.equal(toAudioRelativeSegments(segments, { baseNoteSeconds: 900 })[0].timestamp, 0);
});

test("enrichment keeps whatever the matching domain was, so the note timeline is restored", () => {
  const originals = [
    { id: "seg-1", timestamp: 766.5, endTime: 770, text: "续录第一句", source: "system" },
    { id: "seg-2", timestamp: 772, text: "第二句", source: "system" },
  ];
  // mergeWithTranscript returns copies of the (rebased) matching segments with
  // speaker fields added — for an epoch-ms input their timestamps sit near zero.
  const enriched = [
    { ...originals[0], timestamp: 0.5, endTime: 4, speaker: "speaker_0" },
    { ...originals[1], timestamp: 6, speaker: "speaker_1" },
  ];

  const restored = restoreTranscriptTimestamps(enriched, originals);

  assert.equal(restored[0].timestamp, 766.5);
  assert.equal(restored[0].endTime, 770);
  assert.equal(restored[1].timestamp, 772);
  // Enrichment survives.
  assert.equal(restored[0].speaker, "speaker_0");
  assert.equal(restored[1].speaker, "speaker_1");
});

test("a segment the original does not know keeps its produced fields", () => {
  const originals = [{ id: "seg-1", timestamp: 10 }];
  const enriched = [{ id: "seg-1", timestamp: 10 }, { id: "extra", timestamp: 3 }];

  const restored = restoreTranscriptTimestamps(enriched, originals);

  assert.equal(restored[1].timestamp, 3);
});

test("voiceprint windows count from the audio file's start, not the first line", () => {
  const audioStartMs = 1_800_000_000_000;

  assert.equal(noteAudioSecondsForTimestamp(audioStartMs + 61_500, audioStartMs), 61.5);
  // Timeline-relative notes are shifted by the file's own timeline start.
  assert.equal(noteAudioSecondsForTimestamp(61.5, null), 61.5);
  assert.equal(noteAudioSecondsForTimestamp(827.5, null, 766), 61.5);
  // An absolute stamp without the file start cannot be placed: no guess.
  assert.equal(noteAudioSecondsForTimestamp(audioStartMs + 61_500, null), undefined);
  assert.equal(noteAudioSecondsForTimestamp(undefined, audioStartMs), undefined);
});

test("a session's audio records the note-timeline second its file starts at", () => {
  const sessionStartedAtMs = 1_800_000_000_000;

  // First session: the note timeline starts with this file.
  assert.equal(noteTimelineStartForAudio({ sessionStartedAtMs }), 0);
  // Resumed session: everything earlier already occupies 766s.
  assert.equal(
    noteTimelineStartForAudio({ sessionStartedAtMs, timelineOffsetSeconds: 766 }),
    766
  );
  // Capture began 2.5s after the session did: the file's first sample sits at
  // 768.5 on the note timeline.
  assert.equal(
    noteTimelineStartForAudio({
      sessionStartedAtMs,
      timelineOffsetSeconds: 766,
      audioStartMs: sessionStartedAtMs + 2_500,
    }),
    768.5
  );
  // A missing session anchor still records the resume offset (no invented skew).
  assert.equal(noteTimelineStartForAudio({ timelineOffsetSeconds: 766 }), 766);
  assert.equal(noteTimelineStartForAudio(), 0);
});

test("diarization output is placed on the note timeline before the renderer stores it", () => {
  const sessionStartedAtMs = 1_800_000_000_000;
  const resumeOffset = 766; // earlier sessions already occupy the note

  const segments = [
    { id: "seg-1", timestamp: sessionStartedAtMs + 4_000, endTime: sessionStartedAtMs + 9_500 },
    { id: "seg-2", timestamp: sessionStartedAtMs + 12_000 },
  ];

  const placed = toNoteTimelineSegments(segments, {
    sessionStartedAtMs,
    timelineOffsetSeconds: resumeOffset,
  });

  assert.equal(placed[0].timestamp, 770);
  assert.equal(placed[0].endTime, 775.5);
  assert.equal(placed[1].timestamp, 778);
  // The input is untouched.
  assert.equal(segments[0].timestamp, sessionStartedAtMs + 4_000);
});

test("audio-relative values add the capture skew, absolute ones use the session start", () => {
  const relative = [{ id: "a", timestamp: 12, endTime: 18 }];
  assert.deepEqual(
    toNoteTimelineSegments(relative, { timelineOffsetSeconds: 766 }).map((s) => s.timestamp),
    [778]
  );
  // Capture started 2s after the session did, so file second 12 happened 14s
  // into the session: 766 (earlier sessions) + 14.
  assert.equal(
    toNoteTimelineSegments(relative, {
      audioStartMs: 1_800_000_002_000,
      sessionStartedAtMs: 1_800_000_000_000,
      timelineOffsetSeconds: 766,
    })[0].timestamp,
    780
  );

  const absolute = [{ id: "a", timestamp: 1_800_000_012_000 }];
  // No session anchor: leave it alone rather than inventing a timeline position.
  assert.equal(toNoteTimelineSegments(absolute, { timelineOffsetSeconds: 766 })[0].timestamp, 1_800_000_012_000);
  assert.equal(
    toNoteTimelineSegments(absolute, { sessionStartedAtMs: 1_800_000_000_000, timelineOffsetSeconds: 766 })[0]
      .timestamp,
    778
  );
});
