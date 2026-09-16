import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Minus, Plus, UserRound } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import {
  setSessionExpectedCount,
  resetSessionExpectedCount,
} from "../../stores/meetingRecordingStore";

const MIN_SPEAKERS = 1;
const MAX_SPEAKERS = 16;

interface NoteSpeakerCountProps {
  noteId: number;
  /** Persisted note.expected_speaker_count — null means "auto". */
  value: number | null;
  /** Whether this note is the one currently being recorded. */
  isRecording: boolean;
}

/**
 * Pre-meeting speaker prior: a compact pill in the note header to pin the
 * expected speaker count before (or during) recording. "Auto" hands the
 * decision back to attendee lists and observed speakers.
 */
export default function NoteSpeakerCount({ noteId, value, isRecording }: NoteSpeakerCountProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const persist = (next: number | null) => {
    window.electronAPI?.updateNote?.(noteId, { expected_speaker_count: next });
    if (!isRecording) return;
    if (next == null) {
      resetSessionExpectedCount();
    } else {
      setSessionExpectedCount(next);
    }
  };

  const step = (delta: number) => {
    const current = value ?? MIN_SPEAKERS;
    const next = Math.max(MIN_SPEAKERS, Math.min(MAX_SPEAKERS, current + delta));
    persist(next);
  };

  const chipLabel =
    value == null
      ? t("notes.speakerCount.auto", "Auto speakers")
      : t("notes.speakerCount.count", "{{count}} speakers", { count: value });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex h-6 max-w-36 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border/70 bg-background/75 px-2 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-muted/70 hover:text-foreground cursor-pointer outline-none"
          aria-label={t("notes.speakerCount.label", "Expected speaker count")}
        >
          <UserRound size={11} className="shrink-0" />
          <span className="truncate">{chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3">
        <p className="text-[11px] font-medium text-muted-foreground mb-2">
          {t("notes.speakerCount.hint", "Pin the speaker count to help diarization.")}
        </p>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => step(-1)}
            disabled={value == null || value <= MIN_SPEAKERS}
            aria-label={t("notes.speakerCount.decrease", "Decrease speaker count")}
            className="h-7 w-7 rounded-md border border-border/70 text-foreground/70 hover:bg-muted disabled:opacity-40 cursor-pointer"
          >
            <Minus size={12} className="mx-auto" />
          </button>
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {value ?? t("notes.speakerCount.autoShort", "Auto")}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            disabled={value != null && value >= MAX_SPEAKERS}
            aria-label={t("notes.speakerCount.increase", "Increase speaker count")}
            className="h-7 w-7 rounded-md border border-border/70 text-foreground/70 hover:bg-muted disabled:opacity-40 cursor-pointer"
          >
            <Plus size={12} className="mx-auto" />
          </button>
        </div>
        <button
          type="button"
          onClick={() => persist(null)}
          disabled={value == null}
          className="mt-2 w-full h-7 rounded-md text-[11px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40 cursor-pointer transition-colors"
        >
          {t("notes.speakerCount.resetAuto", "Reset to auto")}
        </button>
      </PopoverContent>
    </Popover>
  );
}
