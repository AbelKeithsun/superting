import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Loader2, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import {
  runTranscriptPolish,
  TranscriptPolishError,
  type RunTranscriptPolishResult,
} from "../../stores/runTranscriptPolish";
import {
  TRANSCRIPT_POLISH_MAX_SELECTION_CHARS,
  TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS,
  type PolishLine,
} from "../../stores/transcriptPolishCore";

interface TranscriptPolishDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  noteId?: number;
  /** Every segment of the note, in transcript order (labels included). */
  lines: PolishLine[];
  /** Contiguous selection the user asked to polish. */
  selectedIds: string[];
  noteContent?: string | null;
  modelId?: string;
  isCloudMode?: boolean;
  /** Called with the segments the user accepted; writes go through the caller. */
  onApply: (updates: Array<{ id: string; text: string }>) => void;
}

/**
 * Confirm step for 选段润色: the model's rewrite is shown per segment and only
 * the rows the user keeps are written back into the transcript. Nothing is
 * applied automatically — a segment that came back wrong costs one click, not a
 * lost transcript.
 */
export default function TranscriptPolishDialog({
  open,
  onOpenChange,
  noteId,
  lines,
  selectedIds,
  noteContent,
  modelId,
  isCloudMode,
  onApply,
}: TranscriptPolishDialogProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [result, setResult] = useState<RunTranscriptPolishResult | null>(null);
  const [errorReason, setErrorReason] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const selectionKey = selectedIds.join("\u0000");

  const lineById = useMemo(() => new Map(lines.map((line) => [line.id ?? "", line])), [lines]);

  const run = useCallback(async () => {
    setStatus("loading");
    setErrorReason(null);
    setErrorMessage("");
    setResult(null);
    setExcluded({});
    try {
      const next = await runTranscriptPolish({
        lines,
        selectedIds,
        noteContent,
        modelId,
        isCloudMode,
        noteId,
      });
      setResult(next);
      setStatus("ready");
    } catch (error) {
      const reason = error instanceof TranscriptPolishError ? error.reason : "generic";
      setErrorReason(reason);
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setStatus("error");
    }
  }, [isCloudMode, lines, modelId, noteContent, noteId, selectedIds]);

  useEffect(() => {
    if (!open || selectedIds.length === 0) return;
    void run();
    // Re-run only when the dialog opens for a different selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selectionKey]);

  const errorText =
    errorReason === "selection-too-large"
      ? t("notes.transcript.polish.error.selection-too-large", {
          max: TRANSCRIPT_POLISH_MAX_SELECTION_CHARS,
        })
      : errorReason === "selection-too-many"
        ? t("notes.transcript.polish.error.selection-too-many", {
            max: TRANSCRIPT_POLISH_MAX_SELECTION_SEGMENTS,
          })
        : errorReason && errorReason !== "generic"
          ? t(`notes.transcript.polish.error.${errorReason}`)
          : t("notes.transcript.polish.error.generic", { message: errorMessage });

  const acceptedUpdates = (result?.updates ?? []).filter((update) => !excluded[update.id]);

  const handleApply = () => {
    if (acceptedUpdates.length === 0) {
      onOpenChange(false);
      return;
    }
    onApply(acceptedUpdates.map((update) => ({ id: update.id, text: update.text })));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={15} />
            {t("notes.transcript.polish.title")}
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          {t("notes.transcript.polish.subtitle", { count: selectedIds.length })}
        </p>

        {status === "loading" && (
          <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t("notes.transcript.polish.loading")}
          </div>
        )}

        {status === "error" && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{errorText}</span>
          </div>
        )}

        {status === "ready" && result && (
          <div className="space-y-3">
            {result.updates.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("notes.transcript.polish.empty")}
              </p>
            ) : (
              <>
                {result.missingIds.length > 0 && (
                  <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/70 px-3 py-2 text-xs text-amber-900">
                    <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                    <span>
                      {t("notes.transcript.polish.missing", { count: result.missingIds.length })}
                    </span>
                  </div>
                )}
                <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
                  {result.updates.map((update) => {
                    const included = !excluded[update.id];
                    return (
                      <div
                        key={update.id}
                        className="rounded-md border border-border/60 px-3 py-2 text-[13px] leading-6"
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[11px] tabular-nums text-muted-foreground/70">
                            {lineById.get(update.id)?.label ?? ""}
                          </span>
                          <button
                            type="button"
                            aria-pressed={included}
                            onClick={() =>
                              setExcluded((prev) => ({ ...prev, [update.id]: included }))
                            }
                            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <Check
                              size={11}
                              className={included ? "text-emerald-600" : "text-muted-foreground/30"}
                            />
                            {t("notes.transcript.polish.include")}
                          </button>
                        </div>
                        <p className="whitespace-pre-wrap text-muted-foreground line-through decoration-muted-foreground/30">
                          {update.previousText}
                        </p>
                        <p className="whitespace-pre-wrap text-slate-950">{update.text}</p>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {status === "error" && (
            <Button variant="outline" onClick={() => void run()}>
              {t("notes.transcript.polish.retry")}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("notes.transcript.polish.cancel")}
          </Button>
          <Button disabled={status !== "ready" || acceptedUpdates.length === 0} onClick={handleApply}>
            {t("notes.transcript.polish.apply", { count: acceptedUpdates.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
