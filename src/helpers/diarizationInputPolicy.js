"use strict";

/**
 * Which audio feeds speaker diarization.
 *
 * The system/remote track is the classic source: in online meetings the remote
 * participants live there, and `mergeWithTranscript(..., assignMicSegments)`
 * attaches the mic's echo of them to those speakers by timestamp overlap. An
 * in-person meeting has no remote track (or a silent one), so that input yields
 * nothing at all; for those we diarize the saved meeting audio (mic + system
 * mix) instead — the same input the "重新分离说话人" action uses.
 */
const DIARIZATION_INPUT_SOURCE = Object.freeze({
  SYSTEM: "system",
  NOTE_AUDIO: "note-audio",
  NONE: "none",
});

function systemTrackState({ hasSystemPcm = false, systemProfile = null } = {}) {
  if (!hasSystemPcm) return "absent";
  if (systemProfile == null) return "unusable";
  return systemProfile === "silent" ? "silent" : "audible";
}

function selectDiarizationInput({
  hasSystemPcm = false,
  systemProfile = null,
  hasNoteAudio = false,
  systemReferenceMs = null,
  noteAudioReferenceMs = null,
} = {}) {
  const state = systemTrackState({ hasSystemPcm, systemProfile });

  if (state === "audible") {
    return {
      source: DIARIZATION_INPUT_SOURCE.SYSTEM,
      referenceMs: systemReferenceMs,
      reason: "system-track-audible",
    };
  }

  if (hasNoteAudio) {
    return {
      source: DIARIZATION_INPUT_SOURCE.NOTE_AUDIO,
      referenceMs: noteAudioReferenceMs ?? systemReferenceMs,
      reason: state === "absent" ? "no-system-track" : `system-track-${state}`,
    };
  }

  return {
    source: DIARIZATION_INPUT_SOURCE.NONE,
    referenceMs: null,
    reason: state === "absent" ? "no-audio" : `system-track-${state}`,
  };
}

module.exports = {
  DIARIZATION_INPUT_SOURCE,
  selectDiarizationInput,
  systemTrackState,
};
