import assert from "node:assert/strict";
import test from "node:test";

import {
  getFinishedDiarizationNoteId,
  getNoteListBackgroundStatus,
} from "../../src/components/notes/noteListDiarizationStatus.ts";

const taskStatus = (noteId: number, taskId = "diarization-1") => ({
  activeTaskCount: 1,
  task: {
    taskId,
    noteId,
    noteTitle: "Meeting",
    audioDurationSeconds: 300,
    startedAt: 1_000,
    estimatedRemainingSeconds: 20,
  },
});

test("note list status shows speaker identification only for the matching note", () => {
  assert.deepEqual(
    getNoteListBackgroundStatus({
      noteId: 12,
      diarizationTaskStatus: taskStatus(12),
      completedDiarizationNoteId: null,
    }),
    {
      kind: "diarization-running",
      translationKey: "notes.list.identifyingSpeakers",
      isLoading: true,
    }
  );

  assert.equal(
    getNoteListBackgroundStatus({
      noteId: 99,
      diarizationTaskStatus: taskStatus(12),
      completedDiarizationNoteId: null,
    }),
    null
  );
});

test("note list status keeps existing action processing ahead of diarization", () => {
  assert.deepEqual(
    getNoteListBackgroundStatus({
      noteId: 12,
      actionLabel: "生成会议纪要",
      isActionProcessing: true,
      diarizationTaskStatus: taskStatus(12),
      completedDiarizationNoteId: 12,
    }),
    {
      kind: "action",
      label: "生成会议纪要",
      isLoading: true,
    }
  );
});

test("note list status can show a short completed speaker identification state", () => {
  assert.deepEqual(
    getNoteListBackgroundStatus({
      noteId: 12,
      diarizationTaskStatus: { activeTaskCount: 0, task: null },
      completedDiarizationNoteId: 12,
    }),
    {
      kind: "diarization-complete",
      translationKey: "notes.list.speakersIdentified",
      isLoading: false,
    }
  );
});

test("finished diarization note is derived from task status transitions", () => {
  const previous = taskStatus(12, "diarization-1");

  assert.equal(
    getFinishedDiarizationNoteId(previous, { activeTaskCount: 0, task: null }),
    12
  );
  assert.equal(getFinishedDiarizationNoteId(null, { activeTaskCount: 0, task: null }), null);
  assert.equal(getFinishedDiarizationNoteId(previous, previous), null);
});
