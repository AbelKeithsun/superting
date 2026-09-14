import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { getRelativeTranscriptSeconds } from "./recordingTime";

export type TranscriptSpeakerStatus = "provisional" | "confirmed" | "suggested" | "locked";
export type TranscriptSpeakerLockSource = "user" | "diarization" | "suggestion";

const SPEAKER_STATE_FIELDS = [
  "speaker",
  "speakerName",
  "speakerIsPlaceholder",
  "suggestedName",
  "suggestedProfileId",
  "speakerStatus",
  "speakerLocked",
  "speakerLockSource",
  "speakerMatchStatus",
  "speakerMatchMethod",
  "speakerMatchReason",
] as const;

type SpeakerStateField = (typeof SPEAKER_STATE_FIELDS)[number];

const normalizeText = (text: string) => text.trim().replace(/\s+/g, " ");

const getSegmentMatchKey = (segment: TranscriptSegment) =>
  [segment.source, segment.timestamp ?? "", normalizeText(segment.text)].join("|");

const canonicalizeTranscriptSpeakerStatus = (
  status?: string,
  speakerLocked?: boolean,
  speakerLockSource?: TranscriptSpeakerLockSource
): TranscriptSpeakerStatus | undefined => {
  if (speakerLocked || speakerLockSource === "user") {
    return "locked";
  }

  switch (status) {
    case "provisional":
    case "confirmed":
    case "suggested":
    case "locked":
      return status;
    case "suggested_profile":
      return "suggested";
    case "user_locked":
      return "locked";
    case "uncertain_overlap":
      return "provisional";
    default:
      return undefined;
  }
};

const pickSpeakerStatus = (segment: TranscriptSegment): TranscriptSpeakerStatus | undefined => {
  const normalizedStatus = canonicalizeTranscriptSpeakerStatus(
    segment.speakerStatus,
    segment.speakerLocked,
    segment.speakerLockSource
  );
  if (normalizedStatus) return normalizedStatus;
  if (segment.suggestedName && !segment.speakerName) return "suggested";
  if (segment.source === "system" && segment.speakerIsPlaceholder) return "provisional";
  if (segment.speaker && segment.speaker !== "you") return "confirmed";
  return undefined;
};

export const isTranscriptSpeakerLocked = (segment: TranscriptSegment) =>
  !!segment.speakerLocked ||
  segment.speakerLockSource === "user" ||
  canonicalizeTranscriptSpeakerStatus(segment.speakerStatus) === "locked";

export const normalizeTranscriptSegment = (segment: TranscriptSegment): TranscriptSegment => {
  const speakerStatus = pickSpeakerStatus(segment);
  const speakerLocked =
    !!segment.speakerLocked || segment.speakerLockSource === "user" || speakerStatus === "locked";
  return {
    ...segment,
    speakerStatus,
    speakerLocked,
    speakerLockSource: speakerLocked
      ? (segment.speakerLockSource ?? "user")
      : segment.speakerLockSource,
  };
};

export const normalizeTranscriptSegments = (segments: TranscriptSegment[]) =>
  segments.map((segment) => normalizeTranscriptSegment(segment));

export const applyTranscriptSpeakerPatch = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>>
) => normalizeTranscriptSegment({ ...segment, ...patch });

export const lockTranscriptSpeaker = (
  segment: TranscriptSegment,
  patch: Partial<Pick<TranscriptSegment, SpeakerStateField>> = {}
) =>
  normalizeTranscriptSegment({
    ...segment,
    ...patch,
    speakerLocked: true,
    speakerStatus: "locked",
    speakerLockSource: "user",
  });

const mergeSpeakerFields = (existing: TranscriptSegment, incoming: TranscriptSegment) => {
  // Text (and any user edits) always stay from `existing`: diarization output
  // carries the raw ASR wording, which would revert a live user edit and, when
  // the edited segment no longer matches, append a duplicate "ghost" row.
  const merged = { ...existing } as TranscriptSegment;
  const existingFields = existing as Record<SpeakerStateField, unknown>;
  const incomingFields = incoming as Record<SpeakerStateField, unknown>;
  const mergedFields = merged as Record<SpeakerStateField, unknown>;

  for (const field of SPEAKER_STATE_FIELDS) {
    if (incomingFields[field] !== undefined) {
      mergedFields[field] = incomingFields[field];
    } else if (mergedFields[field] === undefined && existingFields[field] !== undefined) {
      mergedFields[field] = existingFields[field];
    }
  }

  if (isTranscriptSpeakerLocked(existing)) {
    for (const field of SPEAKER_STATE_FIELDS) {
      if (existingFields[field] !== undefined) {
        mergedFields[field] = existingFields[field];
      }
    }
  }

  return normalizeTranscriptSegment(merged);
};

// Timestamps drift between renderer clocks and diarization timelines; allow a
// small window when correlating raw engine segments with stored ones.
const MERGE_TIMESTAMP_WINDOW_MS = 3000;
// An unmatched incoming segment this close to a user-edited stored segment of
// the same source is the raw-ASR twin of that edit — enrich the stored segment
// instead of appending a ghost duplicate.
const GHOST_GUARD_WINDOW_MS = 2000;

// Persisted transcripts store relative seconds while live diarization output
// carries absolute epoch milliseconds. Window matching needs one domain, so
// re-anchor the incoming timeline onto the existing one end-to-end (session
// ends coincide; within-session spacing is preserved).
const ABSOLUTE_MS_THRESHOLD = 1_000_000_000_000;
const RELATIVE_SECONDS_MAX = 1_000_000_000;

const alignTimestampDomains = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[]
): TranscriptSegment[] => {
  const existingTs = existingSegments
    .map((s) => s.timestamp)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  const incomingTs = incomingSegments
    .map((s) => s.timestamp)
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  if (existingTs.length === 0 || incomingTs.length === 0) return incomingSegments;

  const existingMax = Math.max(...existingTs);
  const incomingMin = Math.min(...incomingTs);
  const incomingIsAbsolute = incomingMin > ABSOLUTE_MS_THRESHOLD;
  const existingIsAbsolute = existingMax > ABSOLUTE_MS_THRESHOLD;
  if (incomingIsAbsolute === existingIsAbsolute) return incomingSegments;
  if (incomingIsAbsolute && existingMax < RELATIVE_SECONDS_MAX) {
    const incomingMax = Math.max(...incomingTs);
    const offsetMs = existingMax * 1000 - incomingMax;
    return incomingSegments.map((s) =>
      typeof s.timestamp === "number" && Number.isFinite(s.timestamp)
        ? { ...s, timestamp: Math.max(0, (s.timestamp + offsetMs) / 1000) }
        : s
    );
  }
  if (!incomingIsAbsolute && incomingMin < RELATIVE_SECONDS_MAX) {
    const incomingMax = Math.max(...incomingTs);
    const offsetSeconds = existingMax - incomingMax;
    return incomingSegments.map((s) =>
      typeof s.timestamp === "number" && Number.isFinite(s.timestamp)
        ? { ...s, timestamp: Math.max(0, s.timestamp + offsetSeconds) }
        : s
    );
  }
  return incomingSegments;
};

const withinMs = (toleranceMs: number, a?: number, b?: number) => {
  if (typeof a !== "number" || typeof b !== "number") return false;
  return Math.abs(a - b) <= toleranceMs;
};

export const mergeTranscriptSegments = (
  existingSegments: TranscriptSegment[],
  incomingSegments: TranscriptSegment[]
) => {
  if (incomingSegments.length === 0) {
    return normalizeTranscriptSegments(existingSegments);
  }
  if (existingSegments.length === 0) {
    return incomingSegments.map((segment, index) =>
      normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
    );
  }

  const incoming = alignTimestampDomains(existingSegments, incomingSegments);

  const existingById = new Map<string, number>();
  const existingByKey = new Map<string, number[]>();
  const existingByOriginalText = new Map<string, number[]>();

  existingSegments.forEach((segment, index) => {
    if (segment.id) existingById.set(segment.id, index);
    const key = getSegmentMatchKey(segment);
    const bucket = existingByKey.get(key);
    if (bucket) bucket.push(index);
    else existingByKey.set(key, [index]);
    if (segment.editedByUser && segment.originalText) {
      const originalKey = [segment.source, normalizeText(segment.originalText)].join("|");
      const originalBucket = existingByOriginalText.get(originalKey);
      if (originalBucket) originalBucket.push(index);
      else existingByOriginalText.set(originalKey, [index]);
    }
  });

  const usedIndexes = new Set<number>();
  const enrichedByIndex = new Map<number, TranscriptSegment>();
  const unmatchedIncoming: TranscriptSegment[] = [];

  // Monotonic two-pointer within a ±window per source: segments arrive in
  // order on both sides, so advance through same-source candidates once.
  const sourceCursors = new Map<string, number>();
  const findWindowMatch = (segment: TranscriptSegment) => {
    const source = segment.source;
    let cursor = sourceCursors.get(source) ?? 0;
    let matchIndex: number | undefined;
    for (let i = cursor; i < existingSegments.length; i++) {
      const candidate = existingSegments[i];
      if (candidate.source !== source || usedIndexes.has(i)) continue;
      if (typeof segment.timestamp === "number" && typeof candidate.timestamp === "number") {
        const delta = segment.timestamp - candidate.timestamp;
        if (delta > MERGE_TIMESTAMP_WINDOW_MS) continue; // not reached yet
        if (Math.abs(delta) <= MERGE_TIMESTAMP_WINDOW_MS) {
          matchIndex = i;
          break;
        }
      } else if (candidate.text === segment.text) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex !== undefined) {
      sourceCursors.set(source, matchIndex + 1);
    }
    return matchIndex;
  };

  incoming.forEach((segment, index) => {
    const findUnused = (candidates?: number[]) =>
      candidates?.find((candidateIndex) => !usedIndexes.has(candidateIndex));

    let matchIndex = segment.id ? existingById.get(segment.id) : undefined;
    if (matchIndex !== undefined && usedIndexes.has(matchIndex)) matchIndex = undefined;

    if (matchIndex === undefined) {
      matchIndex = findUnused(existingByKey.get(getSegmentMatchKey(segment)));
    }

    if (matchIndex === undefined) {
      const fallbackIndex = existingSegments.findIndex(
        (candidate, existingIndex) =>
          !usedIndexes.has(existingIndex) &&
          candidate.source === segment.source &&
          candidate.text === segment.text
      );
      if (fallbackIndex >= 0) matchIndex = fallbackIndex;
    }

    // Edited segments keep their original wording in originalText — match raw
    // diarization output back onto them instead of duplicating.
    if (matchIndex === undefined) {
      const originalKey = [segment.source, normalizeText(segment.text)].join("|");
      matchIndex = findUnused(existingByOriginalText.get(originalKey));
    }

    if (matchIndex === undefined) {
      matchIndex = findWindowMatch(segment);
    }

    if (matchIndex !== undefined) {
      usedIndexes.add(matchIndex);
      enrichedByIndex.set(matchIndex, mergeSpeakerFields(existingSegments[matchIndex], segment));
      return;
    }

    // Ghost guard: a raw segment landing next to a user-edited stored segment
    // of the same source is its ASR original — merge speaker fields only.
    const ghostTwinIndex = existingSegments.findIndex(
      (candidate, existingIndex) =>
        !usedIndexes.has(existingIndex) &&
        candidate.source === segment.source &&
        candidate.editedByUser === true &&
        withinMs(GHOST_GUARD_WINDOW_MS, candidate.timestamp, segment.timestamp)
    );
    if (ghostTwinIndex >= 0) {
      usedIndexes.add(ghostTwinIndex);
      enrichedByIndex.set(
        ghostTwinIndex,
        mergeSpeakerFields(existingSegments[ghostTwinIndex], segment)
      );
      return;
    }

    unmatchedIncoming.push(
      normalizeTranscriptSegment({ ...segment, id: segment.id || `merged-${index}` })
    );
  });

  const preserved = existingSegments.map(
    (segment, index) => enrichedByIndex.get(index) ?? normalizeTranscriptSegment(segment)
  );

  return [...preserved, ...unmatchedIncoming];
};

interface SerializeTranscriptSegmentsOptions {
  recordingStartedAt?: number | null;
}

const getTimelineStartedAt = (
  segments: TranscriptSegment[],
  recordingStartedAt?: number | null
): number | null => {
  if (recordingStartedAt) return recordingStartedAt;
  return (
    segments.find(
      (segment) =>
        typeof segment.timestamp === "number" &&
        Number.isFinite(segment.timestamp) &&
        segment.timestamp > 1_000_000_000
    )?.timestamp ?? null
  );
};

export const serializeTranscriptSegments = (
  segments: TranscriptSegment[],
  options: SerializeTranscriptSegmentsOptions = {}
) => {
  const timelineStartedAt = getTimelineStartedAt(segments, options.recordingStartedAt);
  return JSON.stringify(
    segments.map((segment) => ({
      text: segment.text,
      source: segment.source,
      timestamp: getRelativeTranscriptSeconds(segment.timestamp, timelineStartedAt),
      editedByUser: segment.editedByUser || undefined,
      originalText: segment.originalText || undefined,
      speaker: segment.speaker,
      speakerName: segment.speakerName,
      speakerIsPlaceholder: segment.speakerIsPlaceholder,
      suggestedName: segment.suggestedName,
      suggestedProfileId: segment.suggestedProfileId,
      speakerStatus: segment.speakerStatus,
      speakerLocked: segment.speakerLocked,
      speakerLockSource: segment.speakerLockSource,
    }))
  );
};
