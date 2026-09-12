// Pure speech-segmentation logic for the FunASR VAD pipeline.
//
// Input: per-window speech probabilities produced by the silero VAD ONNX model
// (512-sample windows @16 kHz, LSTM state carried across windows in the worker).
// Output: speech regions as { startSample, endSample } with hysteresis applied:
// a region opens only after `minSpeechDurationMs` of consecutive voiced windows,
// closes after `minSilenceDurationMs` of consecutive silent windows, is force-cut
// at `maxSpeechDurationS`, and padded by `speechPadMs` on both sides.

const WINDOW_SAMPLES = 512;
const SAMPLE_RATE = 16000;

function segmentsFromProbabilities(probs, opts = {}) {
  const {
    windowSamples = WINDOW_SAMPLES,
    sampleRate = SAMPLE_RATE,
    threshold = 0.5,
    minSpeechDurationMs = 250,
    minSilenceDurationMs = 500,
    maxSpeechDurationS = 12,
    speechPadMs = 100,
    totalSamples = Infinity,
  } = opts;

  if (!Array.isArray(probs) || probs.length === 0) return [];

  const windowMs = (windowSamples * 1000) / sampleRate;
  const minSpeechWindows = Math.max(1, Math.round(minSpeechDurationMs / windowMs));
  const minSilenceWindows = Math.max(1, Math.round(minSilenceDurationMs / windowMs));
  const maxSpeechWindows = Math.max(1, Math.round((maxSpeechDurationS * 1000) / windowMs));
  const padSamples = Math.round((speechPadMs / 1000) * sampleRate);

  const segments = [];
  let inSpeech = false;
  let regionStartIdx = null; // first window of the current region
  let voicedRun = 0; // consecutive voiced windows of the tentative/active region
  let silenceRun = 0; // consecutive silent windows of the active region
  let lastVoicedIdx = null;

  const closeRegion = (endIdxExclusive) => {
    // A region re-armed by a max-duration cut may contain no voiced windows at
    // all when speech ended right at the cut — skip padding-only leftovers.
    if (lastVoicedIdx === null || lastVoicedIdx + 1 <= regionStartIdx) return;
    const startSample = Math.max(0, regionStartIdx * windowSamples - padSamples);
    const endSample = Math.min(
      totalSamples,
      endIdxExclusive * windowSamples + padSamples
    );
    if (endSample - startSample > 0) {
      segments.push({ startSample, endSample });
    }
  };

  for (let i = 0; i < probs.length; i++) {
    const voiced = probs[i] >= threshold;

    if (voiced) {
      silenceRun = 0;
      lastVoicedIdx = i;

      if (!inSpeech) {
        if (regionStartIdx === null) regionStartIdx = i;
        voicedRun += 1;
        if (voicedRun >= minSpeechWindows) {
          inSpeech = true;
          if (voicedRun >= maxSpeechWindows) {
            // Region hit the max-duration cap while opening; cut here and
            // re-arm so the continuation opens a fresh region.
            closeRegion(i + 1);
            regionStartIdx = i + 1;
            voicedRun = 0;
            inSpeech = false;
          }
        }
      } else if (i + 1 - regionStartIdx >= maxSpeechWindows) {
        closeRegion(i + 1);
        regionStartIdx = i + 1;
        voicedRun = 0;
        silenceRun = 0;
      }
    } else {
      voicedRun = 0;
      if (!inSpeech) {
        // Tentative region never reached min speech duration: discard.
        if (regionStartIdx !== null && i - regionStartIdx < minSpeechWindows) {
          regionStartIdx = null;
        }
      } else {
        silenceRun += 1;
        if (silenceRun >= minSilenceWindows) {
          closeRegion(lastVoicedIdx + 1);
          regionStartIdx = null;
          inSpeech = false;
          silenceRun = 0;
        }
      }
    }
  }

  if (inSpeech && lastVoicedIdx !== null) {
    closeRegion(lastVoicedIdx + 1);
  }

  return segments;
}

module.exports = { segmentsFromProbabilities, WINDOW_SAMPLES, SAMPLE_RATE };
