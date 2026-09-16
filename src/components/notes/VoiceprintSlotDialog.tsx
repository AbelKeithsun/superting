import { useTranslation } from "react-i18next";
import { Mic } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import type { VoiceprintSummary } from "../../types/electron";

interface VoiceprintSlotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personName: string;
  voiceprints: VoiceprintSummary[];
  maxVoiceprints: number;
  /** Refresh the chosen template with the new sample. */
  onChoose: (voiceprintId: number) => void;
  onCancel: () => void;
}

const formatDate = (value?: string) => {
  if (!value) return "";
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
};

/**
 * A person keeps at most MAX_VOICEPRINTS_PER_PERSON templates, so a new sample
 * has to replace one of them. This dialog is the closed-loop answer: the user
 * sees every existing template (source meeting, date, clip count) and picks the
 * slot to refresh, or cancels — in which case the mark is kept but no template
 * is added, and the renderer says so explicitly.
 */
export default function VoiceprintSlotDialog({
  open,
  onOpenChange,
  personName,
  voiceprints,
  maxVoiceprints,
  onChoose,
  onCancel,
}: VoiceprintSlotDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] gap-4 p-5 sm:max-w-125">
        <DialogHeader>
          <DialogTitle>
            {t("notes.speaker.voiceprintLimitTitle", {
              defaultValue: "{{name}} 已有 {{max}} 条声纹，选择要替换的一条",
              name: personName,
              max: maxVoiceprints,
            })}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("notes.speaker.voiceprintLimitHint", {
            defaultValue:
              "每人最多保留 {{max}} 条声纹。选择一条用本次会议的声音替换，或取消以保留现有声纹（本次标记仍会保留）。",
            max: maxVoiceprints,
          })}
        </p>

        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {voiceprints.map((voiceprint, index) => (
            <div
              key={voiceprint.id}
              data-voiceprint-slot={voiceprint.id}
              className="flex items-center gap-2 rounded-md border border-border/70 bg-background px-2.5 py-2"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/60 text-muted-foreground">
                <Mic size={12} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">
                  {voiceprint.note_title || t("contacts.unnamedNote", "Untitled note")}
                </div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {[
                    formatDate(voiceprint.created_at),
                    t("notes.speaker.voiceprintSlotIndex", {
                      defaultValue: "第 {{index}} 条",
                      index: voiceprints.length - index,
                    }),
                    t("notes.speaker.voiceprintSlotClips", {
                      defaultValue: "{{count}} 段试听",
                      count: voiceprint.segment_count ?? 0,
                    }),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                onClick={() => onChoose(voiceprint.id)}
              >
                {t("notes.speaker.voiceprintReplaceSlot", {
                  defaultValue: "替换这一条",
                })}
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="ghost"
            className="w-full text-xs text-muted-foreground sm:w-auto"
            onClick={onCancel}
          >
            {t("notes.speaker.voiceprintKeepExisting", {
              defaultValue: "取消，保留现有声纹",
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
