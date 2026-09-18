export function getElapsedRecordingSeconds(
  recordingStartedAt: number | null | undefined,
  nowMs = Date.now()
): number {
  if (!recordingStartedAt || !Number.isFinite(recordingStartedAt)) return 0;
  return Math.max(0, Math.floor((nowMs - recordingStartedAt) / 1000));
}

function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
}

export function formatRecordingElapsed(
  recordingStartedAt: number | null | undefined,
  nowMs = Date.now()
): string {
  return formatClock(getElapsedRecordingSeconds(recordingStartedAt, nowMs));
}

/**
 * Seconds on the note timeline for a segment stamp.
 *
 * Segments are normalised to timeline seconds at ingest — the provider's unit is
 * resolved there, where the provider is known (see
 * `src/utils/meetingTranscriptTimeline.ts`). A live session may still hand us an
 * absolute stamp, which is placed relative to the session start; everything else
 * is already timeline seconds and is rendered as-is.
 *
 * Do NOT infer a unit from the value's magnitude here. That guess divided a
 * resumed session's timeline by 100 once it passed the saved audio duration
 * (the note's audio files only cover the finished sessions), so a 33s line
 * rendered as 00:00 and then crawled 00:01 / 00:02 while the recording ran on.
 */
export function getRelativeTranscriptSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt?: number | null
): number | undefined {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;
  // Absolute (wall-clock) milliseconds can only be placed with a session start.
  if (timestamp > 1_000_000_000) {
    if (!recordingStartedAt || !Number.isFinite(recordingStartedAt)) return undefined;
    return Math.max(0, (timestamp - recordingStartedAt) / 1000);
  }
  return Math.max(0, timestamp);
}

export function formatTranscriptTimestamp(
  timestamp: number | null | undefined,
  recordingStartedAt?: number | null
): string {
  const seconds = getRelativeTranscriptSeconds(timestamp, recordingStartedAt);
  return seconds == null ? "" : formatClock(seconds);
}

export function getTranscriptSeekSeconds(
  timestamp: number | null | undefined,
  recordingStartedAt?: number | null
): number | undefined {
  return getRelativeTranscriptSeconds(timestamp, recordingStartedAt);
}

export function shouldApplyMediaSeekNow(media: {
  src?: string | null;
  readyState?: number | null;
}): boolean {
  if (!media.src) return false;
  return Number(media.readyState) >= 1;
}

export interface PlaybackTranscriptSegment {
  id: string;
  timestamp?: number | null;
}

export function getPlaybackActiveSegmentId(
  currentSeconds: number,
  segments: PlaybackTranscriptSegment[],
  recordingStartedAt?: number | null
): string | null {
  if (!Number.isFinite(currentSeconds) || currentSeconds < 0) return null;

  const timeline = segments
    .map((segment) => ({
      id: segment.id,
      seconds: getRelativeTranscriptSeconds(segment.timestamp, recordingStartedAt),
    }))
    .filter((item): item is { id: string; seconds: number } => item.seconds != null)
    .sort((a, b) => a.seconds - b.seconds);

  if (timeline.length === 0 || currentSeconds < timeline[0].seconds) return null;

  let activeId = timeline[0].id;
  for (const item of timeline) {
    if (item.seconds > currentSeconds) break;
    activeId = item.id;
  }
  return activeId;
}
