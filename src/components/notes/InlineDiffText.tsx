import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../lib/utils";
import { computeInlineDiff, correctionDraftAt } from "../../utils/inlineDiff";

interface InlineDiffTextProps {
  oldText: string;
  newText: string;
  /** Called with the (错 → 对) pair when the user clicks a changed run. */
  onCorrectionClick?: (from: string, to: string) => void;
  className?: string;
}

/**
 * Diff-tool style inline view of one polished segment: deleted text in red
 * strikethrough, inserted text in green, unchanged text plain. A changed run
 * that forms a (错 → 对) pair is clickable and hands the pair to the
 * dictionary dialog.
 */
export default function InlineDiffText({
  oldText,
  newText,
  onCorrectionClick,
  className,
}: InlineDiffTextProps) {
  const { t } = useTranslation();
  const runs = useMemo(() => computeInlineDiff(oldText, newText), [oldText, newText]);

  return (
    <p className={cn("whitespace-pre-wrap break-words leading-6", className)}>
      {runs.map((run, index) => {
        if (run.type === "equal") {
          return <span key={index}>{run.text}</span>;
        }
        const draft = onCorrectionClick ? correctionDraftAt(runs, index) : null;
        const clickable = draft !== null;
        return (
          <span
            key={index}
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            title={clickable ? t("notes.transcript.polish.pairTitle") : undefined}
            onClick={clickable ? () => onCorrectionClick?.(draft.from, draft.to) : undefined}
            onKeyDown={
              clickable
                ? (event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onCorrectionClick?.(draft.from, draft.to);
                    }
                  }
                : undefined
            }
            className={cn(
              "rounded-[3px] px-0.5",
              run.type === "del"
                ? "bg-red-100/80 text-red-800 line-through decoration-red-400/60 dark:bg-red-950/60 dark:text-red-300 dark:decoration-red-500/50"
                : "bg-emerald-100/90 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-300",
              clickable &&
                "cursor-pointer transition-shadow hover:ring-1 hover:ring-current focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current"
            )}
          >
            {run.text}
          </span>
        );
      })}
    </p>
  );
}
