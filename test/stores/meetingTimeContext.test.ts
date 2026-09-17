import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMeetingTimeFallback,
  buildMeetingTimeRange,
} from "../../src/stores/meetingTimeContext.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;

test("buildMeetingTimeRange returns null without a recording start", () => {
  assert.equal(
    buildMeetingTimeRange({ recorded_at: null, created_at: null, audio_duration_seconds: 600 }),
    null
  );
});

test("buildMeetingTimeRange returns null without an audio duration", () => {
  assert.equal(
    buildMeetingTimeRange({ recorded_at: "2026-09-15 08:00:00", audio_duration_seconds: null }),
    null
  );
  assert.equal(
    buildMeetingTimeRange({ recorded_at: "2026-09-15 08:00:00", audio_duration_seconds: undefined }),
    null
  );
});

test("buildMeetingTimeRange rejects non-positive durations", () => {
  assert.equal(
    buildMeetingTimeRange({ recorded_at: "2026-09-15 08:00:00", audio_duration_seconds: 0 }),
    null
  );
  assert.equal(
    buildMeetingTimeRange({ recorded_at: "2026-09-15 08:00:00", audio_duration_seconds: -5 }),
    null
  );
});

test("buildMeetingTimeRange rejects unparseable dates", () => {
  assert.equal(
    buildMeetingTimeRange({ recorded_at: "not-a-date", audio_duration_seconds: 600 }),
    null
  );
});

test("buildMeetingTimeRange returns a local-time window spanning the duration", () => {
  const range = buildMeetingTimeRange({
    recorded_at: "2026-09-15 08:00:00", // SQLite UTC
    audio_duration_seconds: 3600,
  });
  assert.ok(range, "expected a range for a valid recording");
  const [start, end] = range.split(" ~ ");
  assert.match(start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(end, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // Both halves are rendered in the local timezone, so parsing them back in
  // local time gives a timezone-independent difference of exactly one hour.
  assert.equal(new Date(end).getTime() - new Date(start).getTime(), ONE_HOUR_MS);
});

test("buildMeetingTimeRange falls back to created_at when recorded_at is missing", () => {
  const range = buildMeetingTimeRange({
    created_at: "2026-09-15 08:00:00",
    audio_duration_seconds: 60,
  });
  assert.ok(range);
  const [start, end] = range.split(" ~ ");
  assert.equal(new Date(end).getTime() - new Date(start).getTime(), 60 * 1000);
});

test("buildMeetingTimeRange accepts ISO timestamps with a Z suffix", () => {
  const range = buildMeetingTimeRange({
    recorded_at: "2026-09-15T08:00:00.000Z",
    audio_duration_seconds: 600,
  });
  assert.ok(range);
  const [start, end] = range.split(" ~ ");
  assert.equal(new Date(end).getTime() - new Date(start).getTime(), 600 * 1000);
});

test("applyMeetingTimeFallback replaces an unspecified 会议时间 line", () => {
  const content = [
    "## 一、会议基本信息",
    "- 会议主题：季度复盘",
    "- 会议时间：未明确",
    "- 参会人员：未明确",
  ].join("\n");
  const result = applyMeetingTimeFallback(content, "2026-09-15 16:00 ~ 2026-09-15 17:00");
  assert.ok(result.includes("- 会议时间：2026-09-15 16:00 ~ 2026-09-15 17:00"));
  // The 参会人员 line must stay untouched.
  assert.ok(result.includes("- 参会人员：未明确"));
});

test("applyMeetingTimeFallback replaces an empty 会议时间 line", () => {
  const result = applyMeetingTimeFallback("- 会议时间：", "2026-09-15 16:00 ~ 17:00");
  assert.ok(result.includes("- 会议时间：2026-09-15 16:00 ~ 17:00"));
});

test("applyMeetingTimeFallback leaves a concrete meeting time alone", () => {
  const content = "- 会议时间：10:00-11:00";
  assert.equal(applyMeetingTimeFallback(content, "2026-09-15 16:00 ~ 17:00"), content);
});

test("applyMeetingTimeFallback handles trailing punctuation on the placeholder", () => {
  const result = applyMeetingTimeFallback("- 会议时间：未知。", "2026-09-15 16:00 ~ 17:00");
  assert.ok(result.includes("- 会议时间：2026-09-15 16:00 ~ 17:00"));
});

test("applyMeetingTimeFallback recognizes English unspecified placeholders", () => {
  const result = applyMeetingTimeFallback("- 会议时间：not specified", "2026-09-15 16:00 ~ 17:00");
  assert.ok(result.includes("- 会议时间：2026-09-15 16:00 ~ 17:00"));
});

test("applyMeetingTimeFallback preserves indentation and bullet style", () => {
  const result = applyMeetingTimeFallback(
    "  * 会议时间：未明确",
    "2026-09-15 16:00 ~ 17:00"
  );
  assert.ok(result.includes("  * 会议时间：2026-09-15 16:00 ~ 17:00"));
});

test("applyMeetingTimeFallback leaves content without a 会议时间 line unchanged", () => {
  const content = "# 会议纪要\n- 参会人员：未明确";
  assert.equal(applyMeetingTimeFallback(content, "2026-09-15 16:00 ~ 17:00"), content);
});
