import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronRight, FolderPlus, Folder } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../lib/utils";
import type { DictionaryGroup } from "../../hooks/useSettings";

interface DictionaryGroupPickerProps {
  groups: DictionaryGroup[];
  trigger: React.ReactNode;
  /** Currently assigned group (null = ungrouped). */
  selectedGroupId: number | null;
  /** Groups that cannot be chosen (self + descendants when moving a group). */
  disabledGroupIds?: Set<number>;
  onSelect: (groupId: number | null) => void;
  onCreateGroup?: (name: string, parentId: number | null) => unknown;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
}

/**
 * Popup group selector used by both "移动到…" (items and groups) and the
 * add-input's target group. Renders the group tree flat with indentation,
 * greys out forbidden targets, and can create a new root group inline.
 */
export default function DictionaryGroupPicker({
  groups,
  trigger,
  selectedGroupId,
  disabledGroupIds,
  onSelect,
  onCreateGroup,
  open,
  onOpenChange,
  align = "start",
  side = "bottom",
}: DictionaryGroupPickerProps) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState("");
  const isControlled = open !== undefined;
  const resolvedOpen = isControlled ? !!open : internalOpen;

  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
    if (!next) {
      setCreating(false);
      setDraftName("");
    }
  };

  const ordered = useMemo(() => {
    const children = new Map<number | null, DictionaryGroup[]>();
    for (const group of groups) {
      const parent = group.parentId ?? null;
      const bucket = children.get(parent) || [];
      bucket.push(group);
      children.set(parent, bucket);
    }
    for (const bucket of children.values()) {
      bucket.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    }
    const flat: Array<{ group: DictionaryGroup; depth: number }> = [];
    const walk = (parent: number | null, depth: number) => {
      for (const group of children.get(parent) || []) {
        flat.push({ group, depth });
        walk(group.id, depth + 1);
      }
    };
    walk(null, 0);
    return flat;
  }, [groups]);

  const commitCreate = async () => {
    const name = draftName.trim();
    if (!name || !onCreateGroup) return;
    await onCreateGroup(name, null);
    setCreating(false);
    setDraftName("");
  };

  return (
    <Popover open={resolvedOpen} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align={align} side={side} className="w-56 p-1">
        <p className="px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("dictionary.groups.moveToTitle")}
        </p>
        <div className="max-h-64 overflow-y-auto">
          <button
            type="button"
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-muted"
          >
            <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
              {selectedGroupId == null && <Check size={11} className="text-primary" />}
            </span>
            <span className="truncate">{t("dictionary.groups.ungrouped")}</span>
          </button>
          {ordered.map(({ group, depth }) => {
            const disabled = disabledGroupIds?.has(group.id) ?? false;
            const selected = selectedGroupId === group.id;
            return (
              <button
                key={group.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  onSelect(group.id);
                  setOpen(false);
                }}
                style={{ paddingLeft: 8 + Math.min(depth, 4) * 12 }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-xs",
                  disabled
                    ? "cursor-not-allowed text-muted-foreground/40"
                    : "text-foreground/80 hover:bg-muted"
                )}
                title={disabled ? t("dictionary.groups.moveInvalid") : undefined}
              >
                <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {selected && <Check size={11} className="text-primary" />}
                </span>
                <Folder size={11} className="shrink-0 text-muted-foreground/70" />
                <span className="truncate">{group.name}</span>
              </button>
            );
          })}
          {ordered.length === 0 && !creating && (
            <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
              {t("dictionary.groups.noGroups")}
            </p>
          )}
        </div>
        {onCreateGroup && (
          <div className="mt-1 border-t border-border/60 pt-1">
            {creating ? (
              <div className="flex items-center gap-1 px-1">
                <input
                  autoFocus
                  value={draftName}
                  onChange={(event) => setDraftName(event.target.value)}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") void commitCreate();
                    if (event.key === "Escape") {
                      setCreating(false);
                      setDraftName("");
                    }
                  }}
                  placeholder={t("dictionary.groups.namePlaceholder")}
                  className="h-7 min-w-0 flex-1 rounded border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus:border-ring/50"
                />
                <button
                  type="button"
                  onClick={() => void commitCreate()}
                  className="h-7 shrink-0 rounded bg-foreground/8 px-2 text-[11px] font-medium text-foreground/75 hover:bg-foreground/12"
                >
                  {t("common.confirm")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <FolderPlus size={11} className="shrink-0" />
                {t("dictionary.groups.new")}
                <ChevronRight size={10} className="ml-auto shrink-0 opacity-60" />
              </button>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
