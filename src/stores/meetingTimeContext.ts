// This module stays dependency-free (only Date) so the Node test runner can
// load it directly — same pattern as noteActionInput.ts keeping its own clock
// formatter instead of importing a shared util.

export interface MeetingTimeSource {
  recorded_at?: string | null;
  created_at?: string | null;
  audio_duration_seconds?: number | null;
}

// DB timestamps are UTC with no timezone marker (SQLite CURRENT_TIMESTAMP) or
// ISO with a trailing Z; either way they represent a UTC instant, so parse
// them as UTC and let Date render in the local timezone.
function normalizeDbDate(dateStr: string): Date {
  const source = dateStr.endsWith("Z") ? dateStr : `${dateStr}Z`;
  return new Date(source);
}

function padTwo(value: number): string {
  return String(value).padStart(2, "0");
}

function formatLocalDateTime(date: Date): string {
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())} ${padTwo(
    date.getHours()
  )}:${padTwo(date.getMinutes())}`;
}

/**
 * Derive the meeting's recording window (local time) from the note's
 * recorded_at (or created_at) plus audio_duration_seconds. Returns null when
 * there is no trustworthy recording window — e.g. a typed note without audio.
 */
export function buildMeetingTimeRange(source: MeetingTimeSource): string | null {
  const startSource = source.recorded_at || source.created_at;
  const duration = source.audio_duration_seconds;
  if (
    !startSource ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    return null;
  }
  const start = normalizeDbDate(startSource);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + duration * 1000);
  return `${formatLocalDateTime(start)} ~ ${formatLocalDateTime(end)}`;
}

// Values a model may write when it did not know the meeting time. The
// fallback below only rewrites the 会议时间 line when it carries one of
// these placeholders — a concrete time the model derived from the
// transcript is left untouched.
const UNSPECIFIED_MEETING_TIME =
  /^(?:未明确|未提及|未提供|未知|待定|不明确|不清楚|无|—|-|－|TBD|N\/A|not\s+(?:specified|provided|mentioned|available)|unknown|unspecified)$/i;

/**
 * Replace an unspecified 会议时间 line with the authoritative recording
 * window. Only touches the "会议时间：" line and only when its value is empty
 * or an "unspecified" placeholder; other lines and concrete values pass
 * through unchanged.
 */
export function applyMeetingTimeFallback(content: string, meetingTimeRange: string): string {
  return content.replace(/^(\s*[-*]\s*会议时间[：:]\s*)(.*)$/gm, (match, prefix, value) => {
    const trimmed = value.trim().replace(/[。．.]$/, "");
    if (!trimmed || UNSPECIFIED_MEETING_TIME.test(trimmed)) {
      return `${prefix}${meetingTimeRange}`;
    }
    return match;
  });
}
