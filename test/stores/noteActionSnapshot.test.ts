import assert from "node:assert/strict";
import test from "node:test";

import { resolveNoteActionSnapshot } from "../../src/stores/noteActionSnapshot.ts";

const dbNote = {
  title: "DB title",
  content: "db content",
  enhanced_content: "db enhanced",
  transcript: "db transcript",
  recorded_at: "2026-06-04 14:00:00",
  created_at: "2026-06-04 13:00:00",
  audio_duration_seconds: 1800,
};

test("falls back to the persisted note when nothing is open in the editor", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, undefined);

  assert.deepEqual(snapshot.note, dbNote);
  assert.deepEqual(snapshot.sources, {
    title: "db",
    content: "db",
    enhanced_content: "db",
    transcript: "db",
  });
  assert.equal(snapshot.snapshotSource, "db");
  assert.equal(snapshot.usedLiveContext, false);
  assert.equal(snapshot.isRecording, false);
});

test("committed editor state wins over the persisted copy", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    title: "Live title",
    content: "live content",
    enhancedContent: "live enhanced",
    transcript: "persisted-but-newer",
  });

  assert.equal(snapshot.note.title, "Live title");
  assert.equal(snapshot.note.content, "live content");
  assert.equal(snapshot.note.enhanced_content, "live enhanced");
  assert.equal(snapshot.note.transcript, "persisted-but-newer");
  assert.equal(snapshot.sources.title, "memory");
  assert.equal(snapshot.sources.content, "memory");
  assert.equal(snapshot.sources.enhanced_content, "memory");
  assert.equal(snapshot.sources.transcript, "memory");
  assert.equal(snapshot.snapshotSource, "memory");
});

test("uncommitted edit-session drafts beat committed editor state", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    content: "committed content",
    enhancedContent: "committed enhanced",
    draftContent: "draft content",
    draftEnhancedContent: "draft enhanced",
  });

  assert.equal(snapshot.note.content, "draft content");
  assert.equal(snapshot.note.enhanced_content, "draft enhanced");
  assert.equal(snapshot.sources.content, "draft");
  assert.equal(snapshot.sources.enhanced_content, "draft");
});

test("an empty draft is a real value, not a missing one", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    content: "committed content",
    enhancedContent: "committed enhanced",
    draftContent: "",
    draftEnhancedContent: null,
  });

  assert.equal(snapshot.note.content, "");
  assert.equal(snapshot.sources.content, "draft");
  // null clears the draft override → the committed value is used again.
  assert.equal(snapshot.note.enhanced_content, "committed enhanced");
  assert.equal(snapshot.sources.enhanced_content, "memory");
});

test("a recording's live transcript beats the periodically-persisted one", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    transcript: "live transcript",
    transcriptIsLive: true,
    isRecording: true,
  });

  assert.equal(snapshot.note.transcript, "live transcript");
  assert.equal(snapshot.sources.transcript, "live");
  assert.equal(snapshot.isRecording, true);
  assert.equal(snapshot.snapshotSource, "live+db");
});

test("a stale mid-recording transcript never silently replaces the DB copy", () => {
  // Live context exists (the note is open) but the recording has produced no
  // transcript yet: the empty live value still wins, so the executor refuses to
  // run instead of quietly generating minutes from an older DB transcript.
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    content: "committed content",
    transcript: "",
    transcriptIsLive: true,
    isRecording: true,
  });

  assert.equal(snapshot.note.transcript, "");
  assert.equal(snapshot.sources.transcript, "live");
});

test("meeting metadata prefers the live context and falls back to the DB row", () => {
  const fromDb = resolveNoteActionSnapshot(dbNote, { content: "x" });
  assert.equal(fromDb.note.recorded_at, dbNote.recorded_at);
  assert.equal(fromDb.note.created_at, dbNote.created_at);
  assert.equal(fromDb.note.audio_duration_seconds, 1800);

  const fromLive = resolveNoteActionSnapshot(dbNote, {
    recordedAt: "2026-07-01 09:00:00",
    createdAt: "2026-07-01 08:00:00",
    audioDurationSeconds: 0,
  });
  assert.equal(fromLive.note.recorded_at, "2026-07-01 09:00:00");
  assert.equal(fromLive.note.created_at, "2026-07-01 08:00:00");
  assert.equal(fromLive.note.audio_duration_seconds, 0);
});

test("survives a missing DB row when the editor holds the live note", () => {
  const snapshot = resolveNoteActionSnapshot(null, {
    title: "T",
    content: "unsaved body",
    transcript: "live transcript",
    transcriptIsLive: true,
  });

  assert.equal(snapshot.note.content, "unsaved body");
  assert.equal(snapshot.note.transcript, "live transcript");
  assert.equal(snapshot.note.created_at, "");
  assert.equal(snapshot.note.recorded_at, null);
  assert.equal(snapshot.note.audio_duration_seconds, null);
  // enhanced_content is neither live nor drafted, so it keeps the (absent) DB origin.
  assert.equal(snapshot.snapshotSource, "memory+live+db");
});

test("snapshot source summarizes every distinct origin in a stable order", () => {
  const snapshot = resolveNoteActionSnapshot(dbNote, {
    title: "memory title",
    draftContent: "draft content",
    transcript: "live transcript",
    transcriptIsLive: true,
  });

  assert.equal(snapshot.snapshotSource, "draft+memory+live+db");
  assert.equal(snapshot.usedLiveContext, true);
});
