const test = require("node:test");
const assert = require("node:assert/strict");

const IPCHandlers = require("../../src/helpers/ipcHandlers");

test("_compressNoteAudioAfterDiarization compresses WAV audio and updates note references", async () => {
  const handler = Object.create(IPCHandlers.prototype);
  const wavName = "SuperTing-meeting-2026-05-29-10-00-00-7.wav";
  const webmName = "SuperTing-meeting-2026-05-29-10-00-00-7.webm";
  const replacements = [];
  const broadcasts = [];
  const mirrored = [];

  handler.audioStorageManager = {
    compressRetainedAudioToOpusWebm: async (filename) => {
      assert.equal(filename, wavName);
      return { success: true, filename: webmName };
    },
    cleanupPendingDeleteAudio: () => ({ deleted: 0 }),
  };
  handler.databaseManager = {
    replaceNoteAudioFilename: (oldFilename, newFilename) => {
      replacements.push([oldFilename, newFilename]);
      return { success: true, affectedNoteIds: [7] };
    },
    getNote: (noteId) => ({ id: noteId, source_file: webmName }),
  };
  handler.broadcastToWindows = (channel, payload) => {
    broadcasts.push([channel, payload]);
  };
  handler._asyncMirrorWrite = (note) => {
    mirrored.push(note);
  };

  const result = await handler._compressNoteAudioAfterDiarization(7, wavName);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.success, true);
  assert.deepEqual(replacements, [[wavName, webmName]]);
  assert.deepEqual(broadcasts, [["note-updated", { id: 7, source_file: webmName }]]);
  assert.deepEqual(mirrored, [{ id: 7, source_file: webmName }]);
});

test("_compressNoteAudioAfterDiarization skips already-compressed audio", async () => {
  const handler = Object.create(IPCHandlers.prototype);
  let compressionCalls = 0;

  handler.audioStorageManager = {
    compressRetainedAudioToOpusWebm: async () => {
      compressionCalls += 1;
      throw new Error("should not compress webm");
    },
  };

  const result = await handler._compressNoteAudioAfterDiarization(
    7,
    "SuperTing-meeting-2026-05-29-10-00-00-7.webm"
  );

  assert.deepEqual(result, { success: true, skipped: true });
  assert.equal(compressionCalls, 0);
});
