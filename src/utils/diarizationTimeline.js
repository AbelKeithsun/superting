"use strict";

/**
 * Where a diarization run's own clock sits on the note's timeline.
 *
 * Speaker diarization always runs over one audio file and reports seconds from
 * the start of that file, while a note transcript stores seconds on the note's
 * own timeline (which keeps growing across stop/start sessions). Mixing the two
 * silently rewrote transcript timestamps: a payload rebased to file seconds was
 * merged into a note timeline, failed the ±3s text match, and was appended as
 * near-zero duplicates — and on the manual "重新分离说话人" path saved straight
 * to the database.
 *
 * Plain CommonJS on purpose: the main process (`src/helpers/*.js`) is loaded
 * directly by Electron and cannot require TypeScript. It stays dependency-free
 * so `node --test` can cover it, and it never infers an origin from the
 * magnitude of a value — a missing anchor means "leave it alone", not "guess".
 */

/** Anything above this is an absolute wall-clock stamp (epoch milliseconds). */
const ABSOLUTE_MS_THRESHOLD = 1_000_000_000;

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

function isAbsoluteMs(value) {
  const numeric = finite(value);
  return numeric != null && numeric > ABSOLUTE_MS_THRESHOLD;
}

/**
 * Segments expressed in seconds from the start of the diarized audio file, for
 * overlap matching only. Absolute stamps are rebased on the audio file's own
 * start; note-timeline values are shifted by `baseNoteSeconds` (the part of the
 * timeline that precedes this audio file) when the caller knows it.
 *
 * Without a usable anchor the segments pass through untouched — matching may
 * then be approximate, but no timestamp is ever invented.
 */
function toAudioRelativeSegments(segments, { audioStartMs, baseNoteSeconds = 0 } = {}) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;
  const anchor = finite(audioStartMs);
  const base = Number.isFinite(baseNoteSeconds) ? baseNoteSeconds : 0;
  if (anchor == null && base === 0) return segments;

  return segments.map((segment) => {
    const next = { ...segment };
    if (anchor != null) {
      const timestamp = finite(segment.timestamp);
      if (timestamp != null) {
        next.timestamp = isAbsoluteMs(timestamp)
          ? Math.max(0, (timestamp - anchor) / 1000)
          : Math.max(0, timestamp - base);
      }
      const endTime = finite(segment.endTime);
      if (endTime != null) {
        next.endTime = isAbsoluteMs(endTime)
          ? Math.max(0, (endTime - anchor) / 1000)
          : Math.max(0, endTime - base);
      }
      return next;
    }

    if (base !== 0) {
      const timestamp = finite(segment.timestamp);
      if (timestamp != null && !isAbsoluteMs(timestamp)) {
        next.timestamp = Math.max(0, timestamp - base);
      }
      const endTime = finite(segment.endTime);
      if (endTime != null && !isAbsoluteMs(endTime)) {
        next.endTime = Math.max(0, endTime - base);
      }
    }
    return next;
  });
}

/**
 * Puts the caller's own timestamps back after enrichment.
 *
 * Diarization only decides *who* spoke: `mergeWithTranscript` carries a segment
 * through untouched apart from the speaker fields (it may merge adjacent
 * utterances, which keeps the first segment's id), so the stored timeline must
 * always come from the input, never from the matching domain it was fed in.
 */
function restoreTranscriptTimestamps(enriched, originals) {
  if (!Array.isArray(enriched) || enriched.length === 0) return enriched;
  if (!Array.isArray(originals) || originals.length === 0) return enriched;

  const byId = new Map();
  for (const segment of originals) {
    if (segment && segment.id) byId.set(segment.id, segment);
  }

  return enriched.map((segment) => {
    const original = segment && segment.id ? byId.get(segment.id) : undefined;
    if (!original) return segment;
    return { ...segment, timestamp: original.timestamp, endTime: original.endTime };
  });
}

/**
 * Seconds into the note's audio for a stored transcript timestamp, used to slice
 * retained audio (voiceprint audition clips). Absolute stamps are rebased on the
 * audio file's own start — not on the first transcript line, which is always
 * later than the file starts. Timeline-relative values are returned as they are.
 */
function noteAudioSecondsForTimestamp(value, audioStartMs) {
  const numeric = finite(value);
  if (numeric == null) return undefined;
  if (!isAbsoluteMs(numeric)) return Math.max(0, numeric);
  const anchor = finite(audioStartMs);
  if (anchor == null) return undefined;
  return Math.max(0, (numeric - anchor) / 1000);
}

/**
 * Segments back onto the note's timeline, mirroring the rule the renderer uses
 * when it ingests a live stamp: `timelineOffsetSeconds + (wallClock −
 * sessionStartedAtMs)/1000`.
 *
 * Two input domains are accepted:
 * - absolute stamps: converted straight from the session's own zero;
 * - audio-relative seconds (the domain used for overlap matching): the capture
 *   skew `(audioStartMs − sessionStartedAtMs)/1000` puts them back on the wall
 *   clock first. Without that anchor only the resume offset is added.
 *
 * Used where diarization output is merged and persisted by the renderer, or
 * becomes the transcript outright. An absolute stamp without `sessionStartedAtMs`
 * is left untouched rather than guessed; the renderer still has its own domain
 * alignment for that case.
 */
function toNoteTimelineSegments(
  segments,
  { audioStartMs, sessionStartedAtMs, timelineOffsetSeconds = 0 } = {}
) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;
  const offset = Number.isFinite(timelineOffsetSeconds) ? timelineOffsetSeconds : 0;
  const sessionStart = finite(sessionStartedAtMs);
  const audioStart = finite(audioStartMs);
  const skewSeconds =
    audioStart != null && sessionStart != null ? (audioStart - sessionStart) / 1000 : 0;

  const convert = (value) => {
    const numeric = finite(value);
    if (numeric == null) return value;
    if (isAbsoluteMs(numeric)) {
      if (sessionStart == null) return value;
      return Math.max(0, offset + (numeric - sessionStart) / 1000);
    }
    return Math.max(0, numeric + skewSeconds + offset);
  };

  return segments.map((segment) => {
    const next = { ...segment };
    if (segment.timestamp !== undefined) next.timestamp = convert(segment.timestamp);
    if (segment.endTime !== undefined) next.endTime = convert(segment.endTime);
    return next;
  });
}

/**
 * Wall-clock ms for a stored DB timestamp. SQLite `CURRENT_TIMESTAMP` rows are
 * UTC without a zone marker, so a bare `YYYY-MM-DD HH:MM:SS` must be read as UTC
 * — `Date.parse` would otherwise treat it as local time and shift the anchor by
 * the timezone offset (hours, i.e. far outside the ±3s match window).
 */
function dbTimestampMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

module.exports = {
  ABSOLUTE_MS_THRESHOLD,
  isAbsoluteMs,
  dbTimestampMs,
  toAudioRelativeSegments,
  restoreTranscriptTimestamps,
  toNoteTimelineSegments,
  noteAudioSecondsForTimestamp,
};
