import { useTranslation } from "react-i18next";
import { ChevronRight, NotebookPen, Upload, Users } from "lucide-react";
import type { NoteItem } from "../../types/electron";
import { cn } from "../lib/utils";
import { normalizeDbDate } from "../../utils/dateFormatting";

/** Timestamp used to place a note on the home timeline. */
export function getNoteTimelineTimestamp(note: NoteItem): string {
  return note.recorded_at || note.created_at || note.updated_at;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^[#>\-*|\s]+/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTranscriptPreview(transcript: string | null): string {
  const trimmed = transcript?.trim() ?? "";
  if (!trimmed) return "";
  if (!trimmed.startsWith("[")) return trimmed;
  try {
    const segments = JSON.parse(trimmed);
    if (!Array.isArray(segments)) return "";
    return segments
      .map((segment) => (typeof segment?.text === "string" ? segment.text.trim() : ""))
      .filter(Boolean)
      .join(" ");
  } catch {
    return "";
  }
}

function buildNotePreview(note: NoteItem): string {
  const source =
    stripMarkdown(note.content ?? "") ||
    stripMarkdown(note.enhanced_content ?? "") ||
    extractTranscriptPreview(note.transcript);
  return source.slice(0, 140);
}

function formatDuration(seconds: number | null): string {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}:${String(mins % 60).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

const TYPE_META = {
  meeting: { icon: Users, badgeKey: "controlPanel.timeline.badgeMeeting" },
  upload: { icon: Upload, badgeKey: "controlPanel.timeline.badgeUpload" },
  personal: { icon: NotebookPen, badgeKey: "controlPanel.timeline.badgeNote" },
} as const;

interface NoteTimelineItemProps {
  note: NoteItem;
  onOpen: (note: NoteItem) => void;
}

export default function NoteTimelineItem({ note, onOpen }: NoteTimelineItemProps) {
  const { t, i18n } = useTranslation();

  const timestampDate = normalizeDbDate(getNoteTimelineTimestamp(note));
  const formattedTime = Number.isNaN(timestampDate.getTime())
    ? ""
    : timestampDate.toLocaleTimeString(i18n.language, {
        hour: "2-digit",
        minute: "2-digit",
      });

  const meta = TYPE_META[note.note_type] ?? TYPE_META.personal;
  const Icon = meta.icon;
  const title = note.title?.trim() || t("notes.list.untitledNote");
  const preview = buildNotePreview(note);
  const duration = formatDuration(note.audio_duration_seconds);

  return (
    <button
      type="button"
      onClick={() => onOpen(note)}
      aria-label={t("controlPanel.timeline.openNote", { title })}
      className={cn(
        "group relative w-full text-left rounded-md px-3 py-2.5 transition-colors duration-150",
        "border border-border/60 bg-background hover:bg-muted/30",
        "dark:border-border-subtle/70 dark:bg-surface-2/50 dark:hover:bg-surface-2/80",
        "cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
      )}
    >
      <div className="flex items-start gap-3">
        {formattedTime && (
          <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums pt-0.5">
            {formattedTime}
          </span>
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Icon size={13} className="shrink-0 text-accent/70" />
            <span className="shrink-0 text-[10px] font-medium px-1 py-px rounded bg-accent/10 text-accent/80">
              {t(meta.badgeKey)}
            </span>
            <span className="text-sm text-foreground/90 font-medium truncate">{title}</span>
            {duration && (
              <span className="shrink-0 text-[11px] text-muted-foreground/70 tabular-nums">
                {duration}
              </span>
            )}
          </div>
          {preview && (
            <p className="text-xs text-muted-foreground mt-1 line-clamp-2 break-words">{preview}</p>
          )}
        </div>

        <ChevronRight
          size={14}
          className="shrink-0 mt-1 text-muted-foreground/30 transition-colors duration-150 group-hover:text-muted-foreground/70"
        />
      </div>
    </button>
  );
}
