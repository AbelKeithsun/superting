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
function toAudioRelativeSegments(
  segments,
  { audioStartMs, baseNoteSeconds = 0, timelineSegments = null } = {}
) {
  if (!Array.isArray(segments) || segments.length === 0) return segments;
  const anchor = finite(audioStartMs);
  const base = Number.isFinite(baseNoteSeconds) ? baseNoteSeconds : 0;
  const hasMap = normalizeTimelineSegments(timelineSegments) != null;
  if (anchor == null && base === 0 && !hasMap) return segments;

  // Note-timeline values go through the file's own map when it has one (a merged
  // file whose sessions sit at different offsets); otherwise the single anchor
  // is the whole map.
  const toFileSeconds = (value) =>
    hasMap
      ? audioSecondsForNoteSeconds(value, {
          timelineStartSeconds: base,
          timelineSegments,
        })
      : Math.max(0, value - base);

  return segments.map((segment) => {
    const next = { ...segment };
    const timestamp = finite(segment.timestamp);
    const endTime = finite(segment.endTime);
    if (anchor != null) {
      if (timestamp != null) {
        next.timestamp = isAbsoluteMs(timestamp)
          ? Math.max(0, (timestamp - anchor) / 1000)
          : toFileSeconds(timestamp);
      }
      if (endTime != null) {
        next.endTime = isAbsoluteMs(endTime)
          ? Math.max(0, (endTime - anchor) / 1000)
          : toFileSeconds(endTime);
      }
      return next;
    }

    if (timestamp != null && !isAbsoluteMs(timestamp)) next.timestamp = toFileSeconds(timestamp);
    if (endTime != null && !isAbsoluteMs(endTime)) next.endTime = toFileSeconds(endTime);
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
 * Note-timeline seconds at which an audio file's first sample sits — the value
 * persisted on `note_audio_files.timeline_start_seconds` when a session's audio
 * is saved.
 *
 * The session's timeline zero is `timelineOffsetSeconds` (everything earlier
 * sessions already occupy), and the file itself may start a little after the
 * session did (capture setup), which is the same skew the live ingest sees.
 * Storing this makes "seconds into this file" and "seconds on the note timeline"
 * convertible in both directions, for any later diarization run or audio slice.
 */
function noteTimelineStartForAudio({
  sessionStartedAtMs,
  timelineOffsetSeconds = 0,
  audioStartMs,
} = {}) {
  const offset = Number.isFinite(timelineOffsetSeconds) ? timelineOffsetSeconds : 0;
  const sessionStart = finite(sessionStartedAtMs);
  const audioStart = finite(audioStartMs);
  const skewSeconds =
    audioStart != null && sessionStart != null ? (audioStart - sessionStart) / 1000 : 0;
  return Math.max(0, offset + skewSeconds);
}

/**
 * Seconds into an audio file for a stored (note-timeline) timestamp, used to
 * slice retained audio. Relative values are shifted by the file's own
 * `timeline_start_seconds`; legacy absolute stamps are rebased on the file's
 * wall-clock start. A missing anchor means "cannot place it" — `undefined`, not
 * a guess.
 */
function noteAudioSecondsForTimestamp(
  value,
  audioStartMs,
  baseNoteSeconds = 0,
  timelineSegments = null
) {
  const numeric = finite(value);
  if (numeric == null) return undefined;
  if (isAbsoluteMs(numeric)) {
    const anchor = finite(audioStartMs);
    if (anchor == null) return undefined;
    return Math.max(0, (numeric - anchor) / 1000);
  }
  const base = Number.isFinite(baseNoteSeconds) ? baseNoteSeconds : 0;
  if (normalizeTimelineSegments(timelineSegments)) {
    return audioSecondsForNoteSeconds(numeric, {
      timelineStartSeconds: base,
      timelineSegments,
    });
  }
  return Math.max(0, numeric - base);
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

/**
 * Breakpoints of a piecewise map from "seconds into an audio file" to "seconds
 * on the note timeline": `[[fileSeconds, noteSeconds], ...]`, ascending in
 * fileSeconds. Both clocks advance at the same rate inside a segment, so the
 * mapping is linear between breakpoints (offset = note − file).
 *
 * A single-session file needs none of this — its whole map is
 * `timeline_start_seconds`. A file merged out of several sessions does: the
 * files are concatenated verbatim (no audio is ever trimmed), so every idle
 * second the note timeline does not contain shifts the later sessions, and only
 * a breakpoint per session can describe that.
 */
function normalizeTimelineSegments(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const points = [];
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length < 2) return null;
    const fileSeconds = finite(entry[0]);
    const noteSeconds = finite(entry[1]);
    if (fileSeconds == null || noteSeconds == null) return null;
    points.push([fileSeconds, noteSeconds]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points;
}

/**
 * Piecewise map for a file built by concatenating `sources` in order. Each
 * source contributes its own breakpoints (or its single `timeline_start_seconds`
 * anchor), shifted by the total duration of everything before it.
 *
 * Returns `null` if any source lacks both a map and an anchor, or has no usable
 * duration: the caller must then leave the merged file without a map rather than
 * invent offsets.
 */
function buildMergedTimelineSegments(sources) {
  if (!Array.isArray(sources) || sources.length === 0) return null;

  const merged = [];
  let offsetSeconds = 0;
  for (const source of sources) {
    const anchor = finite(source?.timelineStartSeconds);
    const points =
      normalizeTimelineSegments(source?.timelineSegments) ||
      (anchor != null ? [[0, anchor]] : null);
    if (!points) return null;
    for (const [fileSeconds, noteSeconds] of points) {
      merged.push([offsetSeconds + fileSeconds, noteSeconds]);
    }
    const duration = finite(source?.durationSeconds);
    if (duration == null || duration <= 0) return null;
    offsetSeconds += duration;
  }

  merged.sort((a, b) => a[0] - b[0]);
  return merged;
}


/**
 * Seconds into an audio file for a moment on the note timeline — the direction
 * diarization matching and audio slicing need.
 *
 * Inside one session both clocks tick 1:1, so the map is a per-session offset;
 * what differs between sessions is how much idle time each side holds (the note
 * timeline resumes ~1s after the previous line, the archived file keeps every
 * recorded second). A note second inside the overlap can only have been
 * transcribed from the later session — the earlier session's lines end before
 * its own anchor — so it resolves to that later session.
 */
function audioSecondsForNoteSeconds(
  noteSeconds,
  { timelineStartSeconds = 0, timelineSegments = null } = {}
) {
  const value = finite(noteSeconds);
  if (value == null) return undefined;
  const points = normalizeTimelineSegments(timelineSegments);
  if (!points) {
    const anchor = finite(timelineStartSeconds);
    return Math.max(0, value - (anchor == null ? 0 : anchor));
  }

  // Last breakpoint whose note second is at or before the requested moment;
  // earlier ones describe sessions that had already finished by then.
  let chosen = points[0];
  for (const point of points) {
    if (point[1] <= value) chosen = point;
    else break;
  }
  const offset = chosen[1] - chosen[0];
  return Math.max(0, value - offset);
}

module.exports = {
  ABSOLUTE_MS_THRESHOLD,
  isAbsoluteMs,
  dbTimestampMs,
  toAudioRelativeSegments,
  restoreTranscriptTimestamps,
  toNoteTimelineSegments,
  noteTimelineStartForAudio,
  noteAudioSecondsForTimestamp,
  normalizeTimelineSegments,
  buildMergedTimelineSegments,
  audioSecondsForNoteSeconds,
};
