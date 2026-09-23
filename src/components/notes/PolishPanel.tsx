import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, BookPlus, Check, Loader2, RotateCcw } from "lucide-react";
import InlineDiffText from "./InlineDiffText";
import CorrectionSubmitDialog, { type CorrectionSubmitDraft } from "./CorrectionSubmitDialog";
import ThinkingStream from "./ThinkingStream";
import StreamStatsBar from "./StreamStatsBar";
import { Button } from "../ui/button";
import {
  applyPolishUpdates,
  clearNoteAiOperation,
  retryPolishChunk,
  startPolishOperation,
  type NoteAiOperation,
} from "../../stores/noteAiOperationStore";

interface PolishPanelProps {
  op: NoteAiOperation;
}

/**
 * 选段润色 in the side drawer: live chunk cards while running, then the diff
 * review (inline red/green, per-segment include toggle, click-to-dictionary),
 * then the applied summary.
 */
export default function PolishPanel({ op }: PolishPanelProps) {
  const { t } = useTranslation();
  const [excluded, setExcluded] = useState<Record<string, boolean>>({});
  const [correctionDrafts, setCorrectionDrafts] = useState<CorrectionSubmitDraft[]>([]);
  const [correctionOpen, setCorrectionOpen] = useState(false);

  const noteId = op.noteId;
  const result = op.polishResult;
  const lineById = useMemo(
    () => new Map((op.polishLines ?? []).map((line) => [line.id ?? "", line])),
    [op.polishLines]
  );

  const latestStreamingIndex = op.chunks.reduce(
    (latest, chunk) => (chunk.phase === "streaming" ? Math.max(latest, chunk.index) : latest),
    -1
  );

  const acceptedUpdates = (result?.updates ?? []).filter((update) => !excluded[update.id]);

  const retryAll = () => {
    if (!op.polishLines || !op.polishSelectedIds) return;
    void startPolishOperation(noteId, {
      lines: op.polishLines,
      selectedIds: op.polishSelectedIds,
      noteContent: op.polishNoteContent,
    });
  };

  return (
    <div className="space-y-3">
      {/* Live chunk cards */}
      {op.chunks.length > 0 && op.status !== "awaiting-review" && (
        <div className="space-y-2">
          {op.chunks.map((chunk) => (
            <div
              key={chunk.index}
              className="space-y-1.5 rounded-md border border-border/60 px-2.5 py-2"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-medium tabular-nums">
                  {t("notes.aiDrawer.chunkLabel", {
                    index: chunk.index + 1,
                    total: op.chunks.length,
                  })}
                </span>
                {chunk.phase === "queued" && (
                  <span className="text-muted-foreground">{t("notes.aiDrawer.phaseQueued")}</span>
                )}
                {chunk.phase === "streaming" && (
                  <Loader2 size={11} className="animate-spin text-indigo-500" />
                )}
                {chunk.phase === "done" && <Check size={11} className="text-emerald-600" />}
                {chunk.phase === "error" && (
                  <AlertTriangle size={11} className="text-destructive" />
                )}
              </div>
              <StreamStatsBar chunk={chunk} />
              {(chunk.reasoningText || chunk.phase === "streaming") && (
                <ThinkingStream
                  text={chunk.reasoningText}
                  kind="reasoning"
                  streaming={chunk.phase === "streaming"}
                  expandedDefault={chunk.index === latestStreamingIndex}
                />
              )}
              {chunk.contentText && <ThinkingStream text={chunk.contentText} kind="content" />}
              {chunk.error && (
                <p className="whitespace-pre-wrap text-[11px] leading-5 text-destructive">
                  {chunk.error}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {op.status === "running" && op.chunks.length === 0 && (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t("notes.transcript.polish.loading")}
        </div>
      )}

      {op.status === "applying" && (
        <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t("notes.aiDrawer.applying")}
        </div>
      )}

      {op.status === "error" && (
        <div className="space-y-2">
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="whitespace-pre-wrap">{op.errorMessage}</span>
          </div>
          <Button variant="outline" size="sm" onClick={retryAll}>
            <RotateCcw size={12} className="mr-1" />
            {t("notes.transcript.polish.retry")}
          </Button>
        </div>
      )}

      {op.status === "done" && (
        <p className="py-4 text-center text-xs text-emerald-700 dark:text-emerald-400">
          {t(op.autoApply ? "notes.aiDrawer.polishDoneAuto" : "notes.aiDrawer.polishDone", {
            count: op.appliedCount ?? 0,
          })}
        </p>
      )}

      {/* Review: per-segment inline diff */}
      {op.status === "awaiting-review" && result && (
        <div className="space-y-3">
          {result.failedChunks.length > 0 && (
            <div className="space-y-1.5">
              {result.failedChunks.map((failed) => (
                <div
                  key={failed.chunkIndex}
                  className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] text-destructive"
                >
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1 whitespace-pre-wrap">{failed.message}</span>
                  <button
                    type="button"
                    onClick={() => void retryPolishChunk(noteId, failed)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-destructive/40 px-1.5 py-0.5 text-[10px] hover:bg-destructive/10"
                  >
                    <RotateCcw size={10} />
                    {t("notes.aiDrawer.retryChunk")}
                  </button>
                </div>
              ))}
            </div>
          )}

          {result.missingIds.length > 0 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/70 px-2.5 py-2 text-[11px] text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>
                {t("notes.transcript.polish.missing", { count: result.missingIds.length })}
              </span>
            </div>
          )}

          {result.updates.length === 0 ? (
            <div className="space-y-2 py-2 text-center">
              <p className="text-xs text-muted-foreground">{t("notes.transcript.polish.empty")}</p>
              <Button variant="ghost" size="sm" onClick={() => clearNoteAiOperation(noteId)}>
                {t("notes.aiDrawer.close")}
              </Button>
            </div>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <BookPlus size={12} className="shrink-0" />
                {t("notes.transcript.polish.dictionaryHint")}
              </p>
              <div className="space-y-2">
                {result.updates.map((update) => {
                  const included = !excluded[update.id];
                  return (
                    <div
                      key={update.id}
                      className="rounded-md border border-border/60 px-2.5 py-2 text-[13px] leading-6"
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
                      <InlineDiffText
                        oldText={update.previousText}
                        newText={update.text}
                        className="text-[13px] text-slate-950 dark:text-foreground"
                        onCorrectionClick={(from, to) => {
                          setCorrectionDrafts([{ from, to }]);
                          setCorrectionOpen(true);
                        }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  className="flex-1 text-muted-foreground"
                  onClick={() => clearNoteAiOperation(noteId)}
                >
                  {t("notes.aiDrawer.polishDiscard")}
                </Button>
                <Button
                  className="flex-1"
                  disabled={acceptedUpdates.length === 0}
                  onClick={() =>
                    void applyPolishUpdates(
                      noteId,
                      acceptedUpdates.map((update) => ({ id: update.id, text: update.text }))
                    )
                  }
                >
                  {t("notes.transcript.polish.apply", { count: acceptedUpdates.length })}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <CorrectionSubmitDialog
        open={correctionOpen}
        onOpenChange={setCorrectionOpen}
        drafts={correctionDrafts}
      />
    </div>
  );
}
