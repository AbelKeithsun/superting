import type { TranscriptSegment } from "../stores/meetingRecordingStore";

const MIN_SEGMENT_GAP_SECONDS = 1;

function getRelativeSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt?: number | null
) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  if (timestamp <= 1_000_000_000) return Math.max(0, timestamp);
  if (!recordingStartedAt || !Number.isFinite(recordingStartedAt)) return undefined;
  return Math.max(0, (timestamp - recordingStartedAt) / 1000);
}

export function getTranscriptTimelineEndSeconds(segments: TranscriptSegment[]): number {
  return segments.reduce((max, segment) => {
    const timestamp = typeof segment.timestamp === "number" ? segment.timestamp : 0;
    return Number.isFinite(timestamp) ? Math.max(max, timestamp) : max;
  }, 0);
}

/**
 * Seconds a resumed session must be shifted by so its segments continue the
 * note timeline instead of restarting at 0. Persisted segments are already
 * timeline-relative, so this is simply the previous end plus the same gap the
 * persist path uses.
 */
export function getTranscriptTimelineOffsetSeconds(seedSegments: TranscriptSegment[]): number {
  if (seedSegments.length === 0) return 0;
  return getTranscriptTimelineEndSeconds(seedSegments) + MIN_SEGMENT_GAP_SECONDS;
}

/**
 * Converts a streaming timestamp into the note's continuous timeline.
 *
 * Live providers report wall-clock epoch milliseconds for the running session
 * ("started speaking at"), while persisted segments are timeline-relative
 * seconds. Mixing the two units made a resumed session restart at 0 — its
 * fresh lines rendered as if they belonged to the top of the previous
 * session, and the note read as if time ran backwards.
 */
export function toTranscriptTimelineSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt: number | null | undefined,
  timelineOffsetSeconds: number
): number | undefined {
  const relative = getRelativeSeconds(timestamp, recordingStartedAt);
  if (relative == null) return undefined;
  if (typeof timestamp === "number" && timestamp <= 1_000_000_000) return relative;
  return Math.max(0, relative + (Number.isFinite(timelineOffsetSeconds) ? timelineOffsetSeconds : 0));
}

export function offsetAppendedTranscriptSegments(
  segments: TranscriptSegment[],
  seedSegments: TranscriptSegment[],
  recordingStartedAt?: number | null
): TranscriptSegment[] {
  if (segments.length === 0 || seedSegments.length === 0) return segments;

  const seedIds = new Set(seedSegments.map((segment) => segment.id));
  const appended = segments.filter((segment) => !seedIds.has(segment.id));
  if (appended.length === 0) return segments;

  const appendedStartSeconds = appended.reduce((min, segment) => {
    const relative = getRelativeSeconds(segment.timestamp, recordingStartedAt);
    if (relative == null || !Number.isFinite(relative)) return min;
    return Math.min(min, relative);
  }, Number.POSITIVE_INFINITY);
  const timelineOffsetSeconds = getTranscriptTimelineOffsetSeconds(seedSegments);
  const appendedStart = Number.isFinite(appendedStartSeconds) ? appendedStartSeconds : 0;
  // Live segments now carry the resumed-session offset from ingest, so they are
  // already on the note timeline and must not be shifted again (that re-anchor
  // is what made repeated autosaves drift). Only a fresh 0-based session — the
  // legacy/epoch path — still needs the shift.
  const baseOffset =
    appendedStart >= timelineOffsetSeconds ? 0 : timelineOffsetSeconds - appendedStart;

  return segments.map((segment) => {
    if (seedIds.has(segment.id)) return segment;
    const relative = getRelativeSeconds(segment.timestamp, recordingStartedAt);
    return {
      ...segment,
      timestamp: relative == null ? undefined : Math.max(0, relative + baseOffset),
    };
  });
}

export function resolveNoteActionTranscript(args: {
  isActiveNoteRecording: boolean;
  realtimeTranscript?: string | null;
  persistedTranscript?: string | null;
}): string | null {
  if (args.isActiveNoteRecording && args.realtimeTranscript?.trim()) {
    return args.realtimeTranscript;
  }
  return args.persistedTranscript || null;
}
