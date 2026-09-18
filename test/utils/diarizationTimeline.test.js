const test = require("node:test");
const assert = require("node:assert/strict");

const {
  audioSecondsForNoteSeconds,
  monotonicNowMs,
  observedTimelineStartSeconds,
  buildMergedTimelineSegments,
  dbTimestampMs,
  normalizeTimelineSegments,
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

test("a merged file keeps a per-session map instead of shifted audio", () => {
  // Session 1 recorded 60s but its last line is at 46s; session 2 starts at 47
  // on the note timeline. The file keeps all 90s, so session 2 sits at file
  // second 60 — the map is what expresses that.
  const map = buildMergedTimelineSegments([
    { durationSeconds: 60, timelineStartSeconds: 0 },
    { durationSeconds: 30, timelineStartSeconds: 47 },
  ]);

  assert.deepEqual(map, [
    [0, 0],
    [60, 47],
  ]);
  // Note timeline -> file seconds, for matching and slicing.
  assert.equal(audioSecondsForNoteSeconds(0, { timelineSegments: map }), 0);
  assert.equal(audioSecondsForNoteSeconds(46, { timelineSegments: map }), 46);
  assert.equal(audioSecondsForNoteSeconds(47, { timelineSegments: map }), 60);
  assert.equal(audioSecondsForNoteSeconds(50, { timelineSegments: map }), 63);
  assert.equal(audioSecondsForNoteSeconds(76, { timelineSegments: map }), 89);
  // Inside one session both clocks tick 1:1 — never interpolated.
  assert.equal(audioSecondsForNoteSeconds(60, { timelineSegments: map }), 73);
});

test("a single-session file needs no map, just its anchor", () => {
  assert.equal(audioSecondsForNoteSeconds(800, { timelineStartSeconds: 766.5 }), 33.5);
  assert.equal(audioSecondsForNoteSeconds(50, {}), 50);
  assert.equal(audioSecondsForNoteSeconds(undefined, {}), undefined);
});

test("merging an already-merged file chains its map", () => {
  const map = buildMergedTimelineSegments([
    { durationSeconds: 60, timelineStartSeconds: 0 },
    // A previously merged file: session 2 starts at file 60 / note 47.
    { durationSeconds: 90, timelineSegments: [[0, 47], [60, 100]] },
  ]);

  assert.deepEqual(map, [
    [0, 0],
    [60, 47],
    [120, 100],
  ]);
  assert.equal(audioSecondsForNoteSeconds(120, { timelineSegments: map }), 140);
});

test("merge maps are refused when an anchor or duration is missing", () => {
  assert.equal(buildMergedTimelineSegments([]), null);
  assert.equal(
    buildMergedTimelineSegments([{ durationSeconds: 10, timelineStartSeconds: null }]),
    null
  );
  assert.equal(buildMergedTimelineSegments([{ timelineStartSeconds: 0 }]), null);
  assert.equal(normalizeTimelineSegments("not json"), null);
  assert.equal(normalizeTimelineSegments([[0, 0], [60]]), null);
  assert.deepEqual(normalizeTimelineSegments("[[60,47],[0,0]]"), [
    [0, 0],
    [60, 47],
  ]);
});

test("the piecewise map is used when converting a note-timeline segment", () => {
  const segments = [
    { id: "s2", timestamp: 50, endTime: 55 },
    { id: "s2b", timestamp: 76 },
  ];
  const map = [
    [0, 0],
    [60, 47],
  ];

  assert.deepEqual(
    toAudioRelativeSegments(segments, { timelineSegments: map }).map((s) => [
      s.timestamp,
      s.endTime,
    ]),
    [
      [63, 68],
      [89, undefined],
    ]
  );
  assert.equal(noteAudioSecondsForTimestamp(50, null, 0, map), 63);
});

test("the anchor is observed from one monotonic interval, not two wall clocks", () => {
  const T0 = 1_800_000_000_000;

  // Session 2 starts 47s into the note; its audio began 1.52s after that.
  assert.equal(
    observedTimelineStartSeconds({
      timelineOffsetSeconds: 47,
      sessionStartedMonoMs: 5_000,
      audioStartMonoMs: 6_520,
    }),
    48.52
  );
  // First session, audio starting immediately.
  assert.equal(
    observedTimelineStartSeconds({ sessionStartedMonoMs: 1_000, audioStartMonoMs: 1_000 }),
    0
  );
  // A negative interval (clock handed over late) never moves the anchor back.
  assert.equal(
    observedTimelineStartSeconds({
      timelineOffsetSeconds: 10,
      sessionStartedMonoMs: 2_000,
      audioStartMonoMs: 1_500,
    }),
    10
  );
  // Nothing observed -> null, so the caller keeps its own derivation.
  assert.equal(observedTimelineStartSeconds({ timelineOffsetSeconds: 47 }), null);
  assert.equal(
    observedTimelineStartSeconds({ sessionStartedMonoMs: 100, audioStartMonoMs: undefined }),
    null
  );
  // The clock itself is monotonic and finite.
  const first = monotonicNowMs();
  const second = monotonicNowMs();
  assert.equal(Number.isFinite(first), true);
  assert.ok(second >= first);
  assert.ok(Math.abs(Date.now() - T0) < 1e12);
});
