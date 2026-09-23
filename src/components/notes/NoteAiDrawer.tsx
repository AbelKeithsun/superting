import { useTranslation } from "react-i18next";
import { Loader2, PanelRightClose, Sparkles, X } from "lucide-react";
import PolishPanel from "./PolishPanel";
import ThinkingStream from "./ThinkingStream";
import StreamStatsBar from "./StreamStatsBar";
import { Button } from "../ui/button";
import { cancelAction } from "../../stores/actionProcessingStore";
import {
  clearNoteAiOperation,
  setNoteAiDrawerOpen,
  useNoteAiDrawerOpen,
  useNoteAiOperation,
  type NoteAiOperation,
} from "../../stores/noteAiOperationStore";

function ActionPanel({ op }: { op: NoteAiOperation }) {
  const { t } = useTranslation();
  const chunk = op.chunks[0];
  const running = op.status === "running";

  return (
    <div className="space-y-2">
      {op.status === "error" && (
        <p className="whitespace-pre-wrap rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {op.errorMessage}
        </p>
      )}
      {chunk && <StreamStatsBar chunk={chunk} />}
      {chunk && (chunk.reasoningText || running) && (
        <ThinkingStream
          text={chunk.reasoningText}
          kind="reasoning"
          streaming={running}
          expandedDefault
        />
      )}
      {chunk?.contentText ? <ThinkingStream text={chunk.contentText} kind="content" /> : null}
      {running && !chunk?.reasoningText && !chunk?.contentText && (
        <div className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" />
          {t("notes.aiDrawer.actionRunning", { name: op.title })}
        </div>
      )}
      {op.status === "done" && (
        <p className="py-2 text-xs text-emerald-700 dark:text-emerald-400">
          {t("notes.aiDrawer.actionDone")}
        </p>
      )}
      {running && (
        <Button variant="outline" size="sm" onClick={() => cancelAction(op.noteId)}>
          {t("common.cancel")}
        </Button>
      )}
    </div>
  );
}

/**
 * Right-docked, non-modal panel hosting AI operations (选段润色 / 笔记动作) so
 * the user can keep scrolling the meeting while a run streams. Lives inside
 * NoteEditor's flex root; state lives in noteAiOperationStore so a run can
 * finish in the background when the user navigates away.
 */
export default function NoteAiDrawer({ noteId }: { noteId: number }) {
  const { t } = useTranslation();
  const op = useNoteAiOperation(noteId);
  const open = useNoteAiDrawerOpen(noteId);

  if (!open || !op) return null;

  const terminal = op.status === "done" || op.status === "error";

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-l border-border/60 bg-background">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Sparkles size={14} className="shrink-0 text-indigo-500" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {op.kind === "polish" ? t("notes.transcript.polish.title") : op.title}
        </span>
        {op.status === "running" && <Loader2 size={12} className="animate-spin text-indigo-500" />}
        {op.status === "awaiting-review" && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
            {t("notes.aiDrawer.reviewBadge")}
          </span>
        )}
        <button
          type="button"
          aria-label={t("notes.aiDrawer.collapse")}
          title={t("notes.aiDrawer.collapse")}
          onClick={() => setNoteAiDrawerOpen(noteId, false)}
          className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        >
          <PanelRightClose size={13} />
        </button>
        {terminal && (
          <button
            type="button"
            aria-label={t("notes.aiDrawer.close")}
            title={t("notes.aiDrawer.close")}
            onClick={() => clearNoteAiOperation(noteId)}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {op.kind === "polish" ? <PolishPanel op={op} /> : <ActionPanel op={op} />}
      </div>
    </aside>
  );
}

/**
 * Small floating re-open button shown while an operation exists but the drawer
 * is collapsed, so a running/awaiting operation is never lost visually.
 */
export function NoteAiDrawerReopenFab({ noteId }: { noteId: number }) {
  const { t } = useTranslation();
  const op = useNoteAiOperation(noteId);
  const open = useNoteAiDrawerOpen(noteId);
  if (!op || open) return null;

  return (
    <button
      type="button"
      onClick={() => setNoteAiDrawerOpen(noteId, true)}
      className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-3 py-1.5 text-xs shadow-lg hover:bg-muted/60"
    >
      <Sparkles size={13} className="text-indigo-500" />
      {op.kind === "polish" ? t("notes.transcript.polish.title") : op.title}
      {op.status === "running" && <Loader2 size={11} className="animate-spin" />}
    </button>
  );
}
