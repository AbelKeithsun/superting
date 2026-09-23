import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useSettings } from "../../hooks/useSettings";

export interface CorrectionSubmitDraft {
  from: string;
  to: string;
}

interface CorrectionSubmitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: CorrectionSubmitDraft[];
  /** Optional learner reason code, rendered as an explanatory hint. */
  reason?: string;
  onSaved?: (savedCount: number) => void;
}

/**
 * Manual exit of the correction loop: when auto-learn is off, or when an edit
 * produced no learnable (错 → 对) pair, the user can still push the correction
 * into the dictionary from here. Writes the same shape as 词典 → 纠错:
 * the corrected word becomes a dictionary hotword and the pair becomes an
 * alias, so ASR prompt and forced replacement both pick it up.
 */
export default function CorrectionSubmitDialog({
  open,
  onOpenChange,
  drafts,
  reason,
  onSaved,
}: CorrectionSubmitDialogProps) {
  const { t } = useTranslation();
  const {
    customDictionary,
    customDictionaryAliases,
    setCustomDictionary,
    setCustomDictionaryAliases,
  } = useSettings();
  const [rows, setRows] = useState<CorrectionSubmitDraft[]>(drafts);

  useEffect(() => {
    if (open) setRows(drafts.length > 0 ? drafts : [{ from: "", to: "" }]);
  }, [open, drafts]);

  const updateRow = useCallback((index: number, patch: Partial<CorrectionSubmitDraft>) => {
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const handleSave = useCallback(() => {
    const valid = rows
      .map((row) => ({ from: row.from.trim(), to: row.to.trim() }))
      .filter((row) => row.to.length > 0);
    if (valid.length === 0) return;

    const nextDictionary = [...customDictionary];
    for (const row of valid) {
      if (!nextDictionary.some((word) => word.toLowerCase() === row.to.toLowerCase())) {
        nextDictionary.push(row.to);
      }
    }

    const nextAliases = [...customDictionaryAliases];
    for (const row of valid) {
      if (!row.from) continue;
      const exists = nextAliases.some(
        (alias) =>
          alias.from.toLowerCase() === row.from.toLowerCase() &&
          alias.to.toLowerCase() === row.to.toLowerCase()
      );
      if (!exists) nextAliases.push({ from: row.from, to: row.to });
    }

    setCustomDictionary(nextDictionary);
    setCustomDictionaryAliases(nextAliases);
    // Persist to SQLite as well — the store write above is localStorage-only,
    // and the main-process pipelines (ASR prompt, replacement aliases, agent
    // CLI/MCP dictionary) read the database. The broadcasts refresh the store
    // with the same values, so this is idempotent.
    try {
      void window.electronAPI?.setDictionary?.(nextDictionary);
      void window.electronAPI?.setDictionaryAliases?.(nextAliases);
    } catch {
      // Bridge unavailable (browser dev) — the store write still applies.
    }
    onSaved?.(valid.length);
    onOpenChange(false);
  }, [
    rows,
    customDictionary,
    customDictionaryAliases,
    setCustomDictionary,
    setCustomDictionaryAliases,
    onSaved,
    onOpenChange,
  ]);

  const reasonHint = reason
    ? t(`notes.transcript.correction.reasons.${reason}`, {
        defaultValue: t("notes.transcript.correction.reasonUnknown"),
      })
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-[calc(100vw-2rem)] gap-4 p-5 sm:max-w-125">
        <DialogHeader>
          <DialogTitle>{t("notes.transcript.correction.dialogTitle")}</DialogTitle>
        </DialogHeader>

        {reasonHint && (
          <p className="text-xs leading-relaxed text-muted-foreground">{reasonHint}</p>
        )}

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div
              key={index}
              className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]"
            >
              <Input
                value={row.from}
                placeholder={t("notes.transcript.correction.fromPlaceholder")}
                onChange={(event) => updateRow(index, { from: event.target.value })}
                className="h-8 text-xs"
              />
              <ArrowRight size={13} className="hidden text-muted-foreground sm:block" />
              <Input
                value={row.to}
                placeholder={t("notes.transcript.correction.toPlaceholder")}
                onChange={(event) => updateRow(index, { to: event.target.value })}
                className="h-8 text-xs"
              />
            </div>
          ))}
        </div>

        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t("notes.transcript.correction.dialogHint")}
        </p>

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            variant="ghost"
            className="w-full text-xs text-muted-foreground sm:w-auto"
            onClick={() => {
              setRows((prev) => [...prev, { from: "", to: "" }]);
            }}
          >
            {t("notes.transcript.correction.addRow")}
          </Button>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="w-full text-xs sm:w-auto"
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              className="w-full text-xs sm:w-auto"
              onClick={handleSave}
              disabled={!rows.some((row) => row.to.trim().length > 0)}
            >
              {t("common.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
