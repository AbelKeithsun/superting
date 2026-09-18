import type { TranscriptSegment } from "../stores/meetingRecordingStore";

const MIN_SEGMENT_GAP_SECONDS = 1;

// Absolute (wall-clock) stamps are epoch milliseconds (~1.7e12); every value on
// the note timeline is far below 1e9 seconds. The threshold separates the two
// domains — it is not a unit guess.
const ABSOLUTE_MS_THRESHOLD = 1_000_000_000;

/** Unit a provider stamps its segments with, before they reach the note timeline. */
export type TranscriptTimestampUnit = "epoch-ms" | "centiseconds" | "seconds";

/**
 * Unit each live meeting provider reports.
 *
 * Every provider wired today stamps wall-clock epoch milliseconds: the local
 * chunked engines are timed by `Date.now()` in the main process, and the cloud
 * realtime streams use the provider's speech-start instant (or `Date.now()`).
 *
 * Units are normalised HERE, at ingest, because this is the only place that
 * knows which provider produced a stamp. The renderer used to infer the unit
 * from the magnitude of the number instead, and that inference divided a
 * resumed session's timeline by 100 the moment it passed the saved audio
 * duration — a 33s line rendered as 00:00 and then crawled 00:01 / 00:02.
 * Never reintroduce magnitude guessing in the render path: register the
 * provider here (with a test) instead.
 */
export const PROVIDER_TIMESTAMP_UNITS: Readonly<Record<string, TranscriptTimestampUnit>> = {
  // Local engines — the main process timestamps every chunk with Date.now().
  whisper: "epoch-ms",
  nvidia: "epoch-ms",
  funasr: "epoch-ms",
  // Cloud realtime streams (`${provider.id}-realtime`).
  "openai-realtime": "epoch-ms",
  "deepgram-realtime": "epoch-ms",
  "assemblyai-realtime": "epoch-ms",
  "superting-realtime": "epoch-ms",
  "enterprise-realtime": "epoch-ms",
};

/**
 * Resolve the unit for an incoming segment. Unknown providers (and payloads
 * that carry no provider at all) fall back to the domain the number sits in:
 * epoch milliseconds above the threshold, note-timeline seconds below it.
 */
export function resolveTranscriptTimestampUnit(
  provider?: string | null,
  timestamp?: number | null
): TranscriptTimestampUnit {
  const key = typeof provider === "string" ? provider.trim().toLowerCase() : "";
  const known = key ? PROVIDER_TIMESTAMP_UNITS[key] : undefined;
  if (known) return known;
  // Every streaming provider is registered as `${provider.id}-realtime`; a new
  // one may arrive before this table is updated, and all of them are timed by
  // the provider's own wall clock.
  if (key.endsWith("-realtime")) return "epoch-ms";
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp > ABSOLUTE_MS_THRESHOLD ? "epoch-ms" : "seconds";
  }
  return "seconds";
}

/**
 * Convert a provider stamp into timeline seconds (before the resume offset).
 * `epoch-ms` needs the session start; without it the stamp cannot be placed on
 * the timeline, so the caller gets `undefined` instead of a guess.
 */
export function transcriptTimestampToSeconds(
  timestamp: number | null | undefined,
  unit: TranscriptTimestampUnit,
  recordingStartedAt?: number | null
): number | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  if (unit === "centiseconds") return Math.max(0, timestamp / 100);
  if (unit === "seconds") return Math.max(0, timestamp);
  if (!recordingStartedAt || !Number.isFinite(recordingStartedAt)) return undefined;
  return Math.max(0, (timestamp - recordingStartedAt) / 1000);
}

function getRelativeSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt?: number | null
) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  return transcriptTimestampToSeconds(
    timestamp,
    resolveTranscriptTimestampUnit(null, timestamp),
    recordingStartedAt
  );
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
 * Convert an already-classified stamp into a position on the note timeline,
 * resume offset included. Every unit goes through the same offset — skipping it
 * for a provider that already reports timeline seconds made a resumed session
 * restart at 0 while its earlier lines stayed at the end of the note.
 */
export function timelineSecondsForUnit(
  timestamp: number | null | undefined,
  unit: TranscriptTimestampUnit,
  recordingStartedAt: number | null | undefined,
  timelineOffsetSeconds: number
): number | undefined {
  const seconds = transcriptTimestampToSeconds(timestamp, unit, recordingStartedAt);
  if (seconds == null) return undefined;
  const offset = Number.isFinite(timelineOffsetSeconds) ? timelineOffsetSeconds : 0;
  return Math.max(0, seconds + offset);
}

/**
 * Converts a streaming timestamp into the note's continuous timeline: the
 * provider's unit is resolved first (see {@link PROVIDER_TIMESTAMP_UNITS}),
 * then the resumed-session offset is applied.
 */
export function toTranscriptTimelineSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt: number | null | undefined,
  timelineOffsetSeconds: number,
  provider?: string | null
): number | undefined {
  return timelineSecondsForUnit(
    timestamp,
    resolveTranscriptTimestampUnit(provider, timestamp),
    recordingStartedAt,
    timelineOffsetSeconds
  );
}

/**
 * Repairs legacy transcripts whose timestamps were persisted in centiseconds.
 *
 * Older builds stored some providers' centisecond stamps verbatim. The renderer
 * used to compensate by guessing the unit from the value's magnitude, which
 * broke every resumed recording (see {@link PROVIDER_TIMESTAMP_UNITS}). The
 * repair now happens once, at the persisted-transcript ingest boundary, and only
 * with evidence: the caller must know the note's audio duration, and the values
 * must not fit it as seconds while their /100 form does. Idempotent — repaired
 * values no longer satisfy the bound.
 */
export function repairLegacyCentisecondTimestamps(
  segments: TranscriptSegment[],
  timelineDurationSeconds?: number | null
): TranscriptSegment[] {
  if (segments.length === 0) return segments;
  if (
    typeof timelineDurationSeconds !== "number" ||
    !Number.isFinite(timelineDurationSeconds) ||
    timelineDurationSeconds <= 0
  ) {
    return segments;
  }

  const limit = timelineDurationSeconds + 30;
  const endSeconds = getTranscriptTimelineEndSeconds(segments);
  if (!(endSeconds > limit) || !(endSeconds / 100 <= limit)) return segments;

  const scale = (value: number | undefined) =>
    typeof value === "number" && Number.isFinite(value) ? Math.max(0, value / 100) : value;

  return segments.map((segment) => ({
    ...segment,
    timestamp: scale(segment.timestamp),
    endTime: scale(segment.endTime),
  }));
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
