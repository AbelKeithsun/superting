interface NoteActionInputOptions {
  noteContent: string;
  rawTranscript?: string | null;
  speakerLabels: {
    you: string;
    them: string;
  };
}

interface StoredTranscriptSegment {
  source?: "mic" | "system";
  text?: string;
  timestamp?: number;
}

// Local copy of the transcript clock format: this module stays dependency-free
// so the Node test runner can load it directly.
function formatSegmentClock(seconds: number | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

function parseStoredTranscriptSegments(raw: string): StoredTranscriptSegment[] {
  if (!raw.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export interface NoteActionInput {
  content: string;
  contentHash: string;
  isMeetingNote: boolean;
}

export function makeActionContentHash(content: string): string {
  return String(content.length) + "-" + content.slice(0, 50);
}

export function buildNoteActionInput({
  noteContent,
  rawTranscript,
  speakerLabels,
}: NoteActionInputOptions): NoteActionInput | null {
  const hasNotes = !!noteContent.trim();
  const transcript = rawTranscript?.trim() || "";
  if (!hasNotes && !transcript) return null;

  let formattedTranscript = "";
  const isMeetingNote = !!transcript;
  if (transcript) {
    const segments = parseStoredTranscriptSegments(transcript);
    if (segments.length > 0) {
      formattedTranscript = segments
        .filter((segment) => typeof segment.text === "string" && segment.text.trim())
        .map((segment) => {
          const speaker = segment.source === "mic" ? speakerLabels.you : speakerLabels.them;
          // Stored segments carry timeline-relative seconds; the built-in
          // minutes prompt asks for chapter timestamps ("if the transcript
          // contains timestamps, keep them"), so pass them through. Without
          // this the model can only answer that no timestamps were provided.
          const time = formatSegmentClock(segment.timestamp);
          return `${time ? `[${time}] ` : ""}${speaker}: ${segment.text}`;
        })
        .join("\n");
    }
    if (!formattedTranscript) {
      formattedTranscript = transcript;
    }
  }

  const content = [
    hasNotes ? noteContent : "",
    formattedTranscript ? `## Meeting Transcript\n${formattedTranscript}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  return { content, contentHash: makeActionContentHash(content), isMeetingNote };
}
