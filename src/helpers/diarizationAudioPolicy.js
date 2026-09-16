const DEFAULT_WINDOW_SECONDS = 300;
const DEFAULT_OVERLAP_SECONDS = 30;

const DIARIZATION_PROFILES = Object.freeze({
  normal: Object.freeze({
    name: "normal",
    threshold: 0.55,
    minDurationOn: 0.2,
    minDurationOff: 0.5,
  }),
  low_signal: Object.freeze({
    name: "low_signal",
    threshold: 0.55,
    minDurationOn: 0.2,
    minDurationOff: 0.5,
    retry: Object.freeze({
      threshold: 0.5,
      minDurationOn: 0.12,
      minDurationOff: 0.35,
      targetPeakDb: -10,
      maxGainDb: 18,
    }),
  }),
  silent: Object.freeze({
    name: "silent",
    skipped: true,
    reason: "silent_or_no_audible_speech",
  }),
});

function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function planDiarizationWindows(durationSeconds, options = {}) {
  const duration = Math.max(0, finiteOr(Number(durationSeconds), 0));
  if (duration === 0) return [];

  const windowSeconds = Math.max(
    1,
    finiteOr(Number(options.windowSeconds), DEFAULT_WINDOW_SECONDS)
  );
  const overlapSeconds = Math.max(
    0,
    Math.min(windowSeconds - 1, finiteOr(Number(options.overlapSeconds), DEFAULT_OVERLAP_SECONDS))
  );
  const stepSeconds = Math.max(1, windowSeconds - overlapSeconds);
  const windows = [];

  for (let startSeconds = 0; startSeconds < duration; startSeconds += stepSeconds) {
    const endSeconds = Math.min(duration, startSeconds + windowSeconds);
    windows.push({
      index: windows.length,
      startSeconds,
      endSeconds,
      durationSeconds: endSeconds - startSeconds,
    });
    if (endSeconds >= duration) break;
  }

  return windows;
}

function selectDiarizationProfile(analysis = {}) {
  const meanVolumeDb = finiteOr(analysis.meanVolumeDb, -Infinity);
  const maxVolumeDb = finiteOr(analysis.maxVolumeDb, -Infinity);
  const activeRatio = finiteOr(analysis.activeRatio, 0);

  if (maxVolumeDb <= -75 || meanVolumeDb <= -85 || activeRatio <= 0.01) {
    return DIARIZATION_PROFILES.silent;
  }

  if (meanVolumeDb <= -55 || maxVolumeDb <= -20 || activeRatio < 0.18) {
    return DIARIZATION_PROFILES.low_signal;
  }

  return DIARIZATION_PROFILES.normal;
}

function scoreDiarizationWindow(analysis = {}, profile = DIARIZATION_PROFILES.normal) {
  const activeRatio = Math.max(0, Math.min(1, finiteOr(analysis.activeRatio, 0)));
  const maxVolumeDb = finiteOr(analysis.maxVolumeDb, -90);
  const volumeScore = Math.max(0, Math.min(1, (maxVolumeDb + 60) / 60));
  const profilePenalty = profile?.name === "low_signal" ? 0.15 : profile?.name === "silent" ? 1 : 0;

  return activeRatio * 0.7 + volumeScore * 0.3 - profilePenalty;
}

function segmentsOverlap(a, b) {
  return Math.min(a.end, b.end) > Math.max(a.start, b.start);
}

function segmentOverlapSeconds(a, b) {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function speakerName(index) {
  return `speaker_${index}`;
}

function assignGlobalSpeakers(windowSegments, referenceSegments, nextSpeakerIndex) {
  const localSpeakers = [];
  const seen = new Set();
  for (const segment of windowSegments.sort((a, b) => a.start - b.start || a.end - b.end)) {
    if (seen.has(segment.localSpeaker)) continue;
    seen.add(segment.localSpeaker);
    localSpeakers.push(segment.localSpeaker);
  }

  const overlapsByLocal = new Map();
  for (const segment of windowSegments) {
    for (const reference of referenceSegments) {
      const overlap = segmentOverlapSeconds(segment, reference);
      if (overlap <= 0) continue;
      const bySpeaker = overlapsByLocal.get(segment.localSpeaker) || new Map();
      bySpeaker.set(reference.speaker, (bySpeaker.get(reference.speaker) || 0) + overlap);
      overlapsByLocal.set(segment.localSpeaker, bySpeaker);
    }
  }

  const matches = [];
  for (const localSpeaker of localSpeakers) {
    const best = [...(overlapsByLocal.get(localSpeaker) || new Map()).entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    )[0];
    if (best) {
      matches.push({ localSpeaker, speaker: best[0], overlap: best[1] });
    }
  }

  const localToGlobal = new Map();
  const usedGlobalSpeakers = new Set();
  for (const match of matches.sort((a, b) => b.overlap - a.overlap)) {
    if (localToGlobal.has(match.localSpeaker) || usedGlobalSpeakers.has(match.speaker)) continue;
    localToGlobal.set(match.localSpeaker, match.speaker);
    usedGlobalSpeakers.add(match.speaker);
  }

  let nextIndex = nextSpeakerIndex;
  for (const localSpeaker of localSpeakers) {
    if (!localToGlobal.has(localSpeaker)) {
      localToGlobal.set(localSpeaker, speakerName(nextIndex));
      nextIndex += 1;
    }
  }

  return { localToGlobal, nextSpeakerIndex: nextIndex };
}

/**
 * options.speakerAssignment: optional Map "<windowIndex>|<localSpeaker>" ->
 * global speaker id, produced by voiceprint re-clustering. When present it
 * replaces the temporal-overlap heuristic, which mints a new global speaker
 * for anyone silent in a window's overlap zone (measured: 132 global
 * speakers on a 41-minute 6-person meeting). Window clusters that have no
 * assignment (their utterances were all too short to embed) inherit the
 * label of the temporally nearest assigned segment.
 */
function mergeWindowSegments(windowResults = [], options = {}) {
  const speakerAssignment =
    options?.speakerAssignment instanceof Map ? options.speakerAssignment : null;
  const candidates = [];
  const referenceSegments = [];
  let nextSpeakerIndex = 0;

  let position = 0;
  for (const result of [...windowResults].sort(
    (a, b) => finiteOr(a?.startSeconds, 0) - finiteOr(b?.startSeconds, 0)
  )) {
    const windowIndex = Number.isFinite(Number(result?.index)) ? Number(result.index) : position;
    position += 1;
    const offset = finiteOr(result?.startSeconds, 0);
    const profile = result?.profile || selectDiarizationProfile(result?.analysis);
    const score = finiteOr(result?.score, scoreDiarizationWindow(result?.analysis, profile));
    const windowSegments = [];

    for (const segment of result?.segments || []) {
      const start = offset + Number(segment.start);
      const end = offset + Number(segment.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      windowSegments.push({
        start,
        end,
        localSpeaker: String(segment.speaker || "speaker_unknown"),
        score,
      });
    }

    if (speakerAssignment) {
      for (const segment of windowSegments) {
        candidates.push({
          start: segment.start,
          end: segment.end,
          speaker: speakerAssignment.get(`${windowIndex}|${segment.localSpeaker}`) || null,
          score: segment.score,
        });
      }
      continue;
    }

    const assignment = assignGlobalSpeakers(windowSegments, referenceSegments, nextSpeakerIndex);
    nextSpeakerIndex = assignment.nextSpeakerIndex;

    for (const segment of windowSegments) {
      const mapped = {
        start: segment.start,
        end: segment.end,
        speaker: assignment.localToGlobal.get(segment.localSpeaker),
        score: segment.score,
      };
      candidates.push(mapped);
      referenceSegments.push(mapped);
    }
  }

  if (speakerAssignment) {
    // Unembeddable micro-clusters take the label of the nearest assigned
    // segment; with no assigned segments at all there is nothing to inherit.
    const assigned = candidates.filter((candidate) => candidate.speaker);
    for (const candidate of candidates) {
      if (candidate.speaker || assigned.length === 0) continue;
      const mid = (candidate.start + candidate.end) / 2;
      let best = null;
      let bestDistance = Infinity;
      for (const other of assigned) {
        const distance = Math.abs((other.start + other.end) / 2 - mid);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = other;
        }
      }
      candidate.speaker = best ? best.speaker : null;
    }
  }

  const selected = [];
  for (const candidate of candidates
    .filter((candidate) => candidate.speaker)
    .sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (selected.some((existing) => segmentsOverlap(existing, candidate))) continue;
    selected.push(candidate);
  }

  return selected
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map(({ start, end, speaker }) => ({ start, end, speaker }));
}

module.exports = {
  DEFAULT_OVERLAP_SECONDS,
  DEFAULT_WINDOW_SECONDS,
  DIARIZATION_PROFILES,
  mergeWindowSegments,
  planDiarizationWindows,
  scoreDiarizationWindow,
  selectDiarizationProfile,
};
