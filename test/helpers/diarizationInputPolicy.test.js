const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DIARIZATION_INPUT_SOURCE,
  selectDiarizationInput,
  systemTrackState,
} = require("../../src/helpers/diarizationInputPolicy.js");

test("system track state reflects presence, usability and audibility", () => {
  assert.equal(systemTrackState({ hasSystemPcm: false }), "absent");
  assert.equal(systemTrackState({ hasSystemPcm: true, systemProfile: null }), "unusable");
  assert.equal(systemTrackState({ hasSystemPcm: true, systemProfile: "silent" }), "silent");
  assert.equal(systemTrackState({ hasSystemPcm: true, systemProfile: "normal" }), "audible");
  assert.equal(systemTrackState({ hasSystemPcm: true, systemProfile: "low_signal" }), "audible");
});

test("an audible system track stays the diarization source", () => {
  const selection = selectDiarizationInput({
    hasSystemPcm: true,
    systemProfile: "normal",
    hasNoteAudio: true,
    systemReferenceMs: 1000,
    noteAudioReferenceMs: 500,
  });

  assert.deepEqual(selection, {
    source: DIARIZATION_INPUT_SOURCE.SYSTEM,
    referenceMs: 1000,
    reason: "system-track-audible",
  });
});

test("in-person meetings fall back to the saved meeting audio", () => {
  const silentSystem = selectDiarizationInput({
    hasSystemPcm: true,
    systemProfile: "silent",
    hasNoteAudio: true,
    systemReferenceMs: 114000,
    noteAudioReferenceMs: 0,
  });

  assert.deepEqual(silentSystem, {
    source: DIARIZATION_INPUT_SOURCE.NOTE_AUDIO,
    referenceMs: 0,
    reason: "system-track-silent",
  });

  const noSystem = selectDiarizationInput({
    hasNoteAudio: true,
    noteAudioReferenceMs: 0,
  });

  assert.deepEqual(noSystem, {
    source: DIARIZATION_INPUT_SOURCE.NOTE_AUDIO,
    referenceMs: 0,
    reason: "no-system-track",
  });
});

test("the note audio reference wins when it is known", () => {
  const selection = selectDiarizationInput({
    hasSystemPcm: true,
    systemProfile: null,
    hasNoteAudio: true,
    systemReferenceMs: 2000,
  });

  assert.deepEqual(selection, {
    source: DIARIZATION_INPUT_SOURCE.NOTE_AUDIO,
    referenceMs: 2000,
    reason: "system-track-unusable",
  });
});

test("no usable input reports the concrete skip reason", () => {
  assert.deepEqual(selectDiarizationInput({}), {
    source: DIARIZATION_INPUT_SOURCE.NONE,
    referenceMs: null,
    reason: "no-audio",
  });

  assert.deepEqual(selectDiarizationInput({ hasSystemPcm: true, systemProfile: "silent" }), {
    source: DIARIZATION_INPUT_SOURCE.NONE,
    referenceMs: null,
    reason: "system-track-silent",
  });
});
