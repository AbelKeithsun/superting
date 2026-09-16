import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Folder,
  FolderPlus,
  FolderTree,
  MoreHorizontal,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { cn } from "../lib/utils";
import DictionaryGroupPicker from "./DictionaryGroupPicker";
import type { DictionaryDisplayItem } from "../../utils/dictionaryListItems";
import type { DictionaryGroup, DictionaryGroupAssignments } from "../../hooks/useSettings";

type MutationResult = { success: boolean; errorCode?: string | null; error?: string };

interface DictionaryGroupTreeProps {
  groups: DictionaryGroup[];
  assignments: DictionaryGroupAssignments;
  items: DictionaryDisplayItem[];
  /** Already filtered by the search box. */
  filteredItems: DictionaryDisplayItem[];
  query: string;
  agentName: string | null;
  onRemoveWord: (word: string) => void;
  onRemoveAlias: (from: string) => void;
  onMoveItem: (item: DictionaryDisplayItem, groupId: number | null) => void;
  onCreateGroup: (name: string, parentId: number | null) => Promise<MutationResult>;
  onRenameGroup: (id: number, name: string) => Promise<MutationResult>;
  onDeleteGroup: (group: DictionaryGroup) => void;
  onMoveGroup: (id: number, parentId: number | null) => Promise<MutationResult>;
  /** Item that should be revealed (and have its move picker opened) once. */
  focusedItemId?: string | null;
  onFocusHandled?: () => void;
}

const COLLAPSED_STORAGE_KEY = "superting.dictionary.groups.collapsed";

function readCollapsed(): Set<number> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : []);
  } catch {
    return new Set();
  }
}

const itemKey = (item: DictionaryDisplayItem) =>
  item.type === "word" ? `word:${item.word}` : `alias:${item.from}`;

export default function DictionaryGroupTree({
  groups,
  assignments,
  items,
  filteredItems,
  query,
  agentName,
  onRemoveWord,
  onRemoveAlias,
  onMoveItem,
  onCreateGroup,
  onRenameGroup,
  onDeleteGroup,
  onMoveGroup,
  focusedItemId,
  onFocusHandled,
}: DictionaryGroupTreeProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState<Set<number>>(() => readCollapsed());
  const [creatingParentId, setCreatingParentId] = useState<number | null | undefined>(undefined);
  const [createDraft, setCreateDraft] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [autoOpenItemKey, setAutoOpenItemKey] = useState<string | null>(null);
  const [movingGroupId, setMovingGroupId] = useState<number | null>(null);
  const [actionsOpenId, setActionsOpenId] = useState<number | null>(null);
  const revealedFocusRef = useRef<string | null>(null);

  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  const childrenByParent = useMemo(() => {
    const map = new Map<number | null, DictionaryGroup[]>();
    for (const group of groups) {
      const parent = group.parentId ?? null;
      const bucket = map.get(parent) || [];
      bucket.push(group);
      map.set(parent, bucket);
    }
    for (const bucket of map.values()) {
      bucket.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id);
    }
    return map;
  }, [groups]);

  const groupOfItem = useCallback(
    (item: DictionaryDisplayItem): number | null => {
      const raw =
        item.type === "word"
          ? assignments.words?.[item.word]
          : assignments.aliases?.[item.from];
      if (raw == null) return null;
      // Assignments pointing at a deleted group fall back to "ungrouped".
      return groupById.has(raw) ? raw : null;
    },
    [assignments, groupById]
  );

  const itemsByGroup = useMemo(() => {
    const map = new Map<number | null, DictionaryDisplayItem[]>();
    for (const item of items) {
      const groupId = groupOfItem(item);
      const bucket = map.get(groupId) || [];
      bucket.push(item);
      map.set(groupId, bucket);
    }
    return map;
  }, [items, groupOfItem]);

  const pathOfGroup = useCallback(
    (groupId: number | null): string => {
      if (groupId == null) return t("dictionary.groups.ungrouped");
      const names: string[] = [];
      let cursor: number | null = groupId;
      const guard = new Set<number>();
      while (cursor != null && groupById.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        const group = groupById.get(cursor)!;
        names.unshift(group.name);
        cursor = group.parentId ?? null;
      }
      return names.join(" / ");
    },
    [groupById, t]
  );

  const descendantIds = useCallback(
    (groupId: number): Set<number> => {
      const result = new Set<number>([groupId]);
      const walk = (id: number) => {
        for (const child of childrenByParent.get(id) || []) {
          result.add(child.id);
          walk(child.id);
        }
      };
      walk(groupId);
      return result;
    },
    [childrenByParent]
  );

  const persistCollapsed = (next: Set<number>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      /* ignore quota / private-mode errors */
    }
  };

  const toggleCollapsed = (groupId: number) => {
    const next = new Set(collapsed);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    persistCollapsed(next);
  };

  const expandAncestors = useCallback(
    (groupId: number | null) => {
      if (groupId == null) return;
      const next = new Set(collapsed);
      let cursor: number | null = groupId;
      const guard = new Set<number>();
      while (cursor != null && groupById.has(cursor) && !guard.has(cursor)) {
        guard.add(cursor);
        next.delete(cursor);
        cursor = groupById.get(cursor)!.parentId ?? null;
      }
      persistCollapsed(next);
    },
    [collapsed, groupById]
  );

  // External focus contract: an item id handed over via localStorage gets
  // revealed once, with its move picker open (used by auto-learned words).
  useEffect(() => {
    if (!focusedItemId || revealedFocusRef.current === focusedItemId) return;
    const target = items.find((item) => itemKey(item) === focusedItemId);
    revealedFocusRef.current = focusedItemId;
    if (target) {
      expandAncestors(groupOfItem(target));
      setAutoOpenItemKey(itemKey(target));
    }
    onFocusHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedItemId, items]);

  const siblingNameTaken = (name: string, parentId: number | null, excludeId?: number) => {
    const key = name.trim().toLowerCase();
    return (childrenByParent.get(parentId) || []).some(
      (group) => group.id !== excludeId && group.name.trim().toLowerCase() === key
    );
  };

  const submitCreate = async (parentId: number | null) => {
    const name = createDraft.trim();
    if (!name) {
      setCreatingParentId(undefined);
      setCreateDraft("");
      setInlineError(null);
      return;
    }
    if (siblingNameTaken(name, parentId)) {
      setInlineError(t("dictionary.groups.duplicateName"));
      return;
    }
    const result = await onCreateGroup(name, parentId);
    if (!result?.success) {
      setInlineError(
        result?.errorCode === "duplicate-group-name"
          ? t("dictionary.groups.duplicateName")
          : result?.error || t("dictionary.groups.createFailed")
      );
      return;
    }
    if (parentId != null) expandAncestors(parentId);
    setCreatingParentId(undefined);
    setCreateDraft("");
    setInlineError(null);
  };

  const submitRename = async (group: DictionaryGroup) => {
    const name = renameDraft.trim();
    if (!name || name === group.name) {
      setRenamingId(null);
      setRenameDraft("");
      setInlineError(null);
      return;
    }
    if (siblingNameTaken(name, group.parentId ?? null, group.id)) {
      setInlineError(t("dictionary.groups.duplicateName"));
      return;
    }
    const result = await onRenameGroup(group.id, name);
    if (!result?.success) {
      setInlineError(
        result?.errorCode === "duplicate-group-name"
          ? t("dictionary.groups.duplicateName")
          : result?.error || t("dictionary.groups.renameFailed")
      );
      return;
    }
    setRenamingId(null);
    setRenameDraft("");
    setInlineError(null);
  };

  const renderItemRow = (item: DictionaryDisplayItem, path?: string) => {
    const isAgentWord = item.type === "word" && item.word === agentName;
    const isFocused = autoOpenItemKey === itemKey(item);
    return (
      <div
        key={item.id}
        data-dictionary-item={itemKey(item)}
        className={cn(
          "group flex min-h-10 items-center gap-2 py-1.5 pl-4 pr-3 transition-colors duration-150 hover:bg-muted/35",
          isFocused && "bg-primary/5"
        )}
      >
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium",
            item.type === "word"
              ? "border-border/60 bg-background text-muted-foreground dark:border-white/10 dark:bg-white/[0.03]"
              : "border-primary/20 bg-primary/10 text-primary dark:border-primary/25 dark:bg-primary/15"
          )}
          title={isAgentWord ? t("dictionary.autoManaged") : undefined}
        >
          {item.type === "word" ? t("dictionary.itemTypeWord") : t("dictionary.itemTypeAlias")}
        </span>
        <div className="min-w-0 flex-1">
          {item.type === "word" ? (
            <div className="truncate text-sm font-semibold text-foreground">{item.word}</div>
          ) : (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="min-w-0 max-w-full break-words text-muted-foreground">
                {item.from}
              </span>
              <ArrowRight size={12} className="shrink-0 text-muted-foreground/70" />
              <span className="min-w-0 max-w-full break-words font-semibold text-foreground">
                {item.to}
              </span>
            </div>
          )}
          {path && (
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
              <Folder size={9} className="shrink-0" />
              <span className="truncate">{path}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <DictionaryGroupPicker
            groups={groups}
            selectedGroupId={groupOfItem(item)}
            open={isFocused || undefined}
            onOpenChange={(open) => {
              if (!open && isFocused) setAutoOpenItemKey(null);
            }}
            onSelect={(groupId) => onMoveItem(item, groupId)}
            trigger={
              <button
                type="button"
                aria-label={t("dictionary.groups.moveTo")}
                title={t("dictionary.groups.moveTo")}
                className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                <FolderTree size={11} />
                {t("dictionary.groups.moveTo")}
              </button>
            }
          />
          {!(item.type === "word" && isAgentWord) && (
            <button
              type="button"
              onClick={() =>
                item.type === "word" ? onRemoveWord(item.word) : onRemoveAlias(item.from)
              }
              aria-label={
                item.type === "word"
                  ? t("dictionary.removeWord", { word: item.word })
                  : t("dictionary.removeAlias", { from: item.from, to: item.to })
              }
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
            >
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderInlineCreateRow = (parentId: number | null, depth: number) => (
    <div
      key={`create-${parentId ?? "root"}`}
      className="flex items-center gap-2 py-1.5 pr-3"
      style={{ paddingLeft: 12 + Math.min(depth, 4) * 14 }}
    >
      <CornerDownRight size={12} className="shrink-0 text-muted-foreground/60" />
      <input
        autoFocus
        value={createDraft}
        onChange={(event) => {
          setCreateDraft(event.target.value);
          setInlineError(null);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") void submitCreate(parentId);
          if (event.key === "Escape") {
            setCreatingParentId(undefined);
            setCreateDraft("");
            setInlineError(null);
          }
        }}
        placeholder={t("dictionary.groups.namePlaceholder")}
        className="h-7 min-w-0 flex-1 rounded border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus:border-ring/50"
      />
      <button
        type="button"
        onClick={() => void submitCreate(parentId)}
        className="h-7 shrink-0 rounded bg-foreground/8 px-2 text-[11px] font-medium text-foreground/75 hover:bg-foreground/12"
      >
        {t("common.confirm")}
      </button>
      <button
        type="button"
        onClick={() => {
          setCreatingParentId(undefined);
          setCreateDraft("");
          setInlineError(null);
        }}
        className="h-7 shrink-0 rounded px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {t("common.cancel")}
      </button>
    </div>
  );

  const renderGroup = (group: DictionaryGroup, depth: number): React.ReactNode => {
    const children = childrenByParent.get(group.id) || [];
    const isCollapsed = collapsed.has(group.id);
    const groupItems = itemsByGroup.get(group.id) || [];
    const isRenaming = renamingId === group.id;

    return (
      <div key={group.id} data-dictionary-group={group.id}>
        <div
          className="group flex min-h-10 items-center gap-1.5 py-1.5 pr-2 hover:bg-muted/25"
          style={{ paddingLeft: 8 + Math.min(depth, 4) * 14 }}
        >
          <button
            type="button"
            onClick={() => toggleCollapsed(group.id)}
            aria-label={isCollapsed ? t("dictionary.groups.expand") : t("dictionary.groups.collapse")}
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <Folder size={13} className="shrink-0 text-primary/70" />
          {isRenaming ? (
            <input
              autoFocus
              value={renameDraft}
              onChange={(event) => {
                setRenameDraft(event.target.value);
                setInlineError(null);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") void submitRename(group);
                if (event.key === "Escape") {
                  setRenamingId(null);
                  setRenameDraft("");
                  setInlineError(null);
                }
              }}
              className="h-7 min-w-0 flex-1 rounded border border-border/70 bg-background px-2 text-xs font-medium text-foreground outline-none focus:border-ring/50"
            />
          ) : (
            <button
              type="button"
              onClick={() => toggleCollapsed(group.id)}
              className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-foreground"
            >
              {group.name}
            </button>
          )}
          <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {t("dictionary.groups.itemCount", { count: groupItems.length })}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              onClick={() => {
                setCreatingParentId(group.id);
                setCreateDraft("");
                setInlineError(null);
                expandAncestors(group.id);
              }}
              aria-label={t("dictionary.groups.newSubgroup")}
              title={t("dictionary.groups.newSubgroup")}
              className="flex h-6 items-center gap-1 rounded-md px-1.5 text-[10px] font-medium text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
            >
              <FolderPlus size={11} />
              {t("dictionary.groups.newSubgroup")}
            </button>
            {/* Kept out of the actions menu on purpose: a popover nested
                inside another popover would close with its parent. */}
            <DictionaryGroupPicker
              groups={groups}
              selectedGroupId={group.parentId ?? null}
              disabledGroupIds={descendantIds(group.id)}
              open={movingGroupId === group.id || undefined}
              onOpenChange={(open) => {
                if (!open) setMovingGroupId(null);
              }}
              onSelect={(parentId) => void onMoveGroup(group.id, parentId)}
              trigger={
                <button
                  type="button"
                  aria-label={t("dictionary.groups.moveTo")}
                  title={t("dictionary.groups.moveTo")}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground"
                >
                  <FolderTree size={12} />
                </button>
              }
            />
            <Popover
              open={actionsOpenId === group.id}
              onOpenChange={(open) => setActionsOpenId(open ? group.id : null)}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t("dictionary.groups.groupActions")}
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                >
                  <MoreHorizontal size={13} />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-1">
                <button
                  type="button"
                  onClick={() => {
                    setActionsOpenId(null);
                    setRenamingId(group.id);
                    setRenameDraft(group.name);
                    setInlineError(null);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-muted"
                >
                  <Pencil size={11} />
                  {t("dictionary.groups.rename")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActionsOpenId(null);
                    setMovingGroupId(group.id);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-foreground/80 hover:bg-muted"
                >
                  <FolderTree size={11} />
                  {t("dictionary.groups.moveTo")}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setActionsOpenId(null);
                    onDeleteGroup(group);
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-destructive/90 hover:bg-destructive/10"
                >
                  <Trash2 size={11} />
                  {t("dictionary.groups.delete")}
                </button>
              </PopoverContent>
            </Popover>
          </div>
        </div>

        {!isCollapsed && (
          <>
            {creatingParentId === group.id && renderInlineCreateRow(group.id, depth + 1)}
            {groupItems.length === 0 && creatingParentId !== group.id ? (
              <p
                className="py-1 text-[11px] text-muted-foreground/70"
                style={{ paddingLeft: 34 + Math.min(depth + 1, 4) * 14 }}
              >
                {t("dictionary.groups.emptyGroup")}
              </p>
            ) : (
              groupItems.map((item) => renderItemRow(item))
            )}
            {children.map((child) => renderGroup(child, depth + 1))}
          </>
        )}
      </div>
    );
  };

  if (query.trim()) {
    return (
      <div className="divide-y divide-border/60 dark:divide-white/8">
        {filteredItems.map((item) => renderItemRow(item, pathOfGroup(groupOfItem(item))))}
      </div>
    );
  }

  const rootGroups = childrenByParent.get(null) || [];
  const ungroupedItems = itemsByGroup.get(null) || [];

  return (
    <div className="divide-y divide-border/60 dark:divide-white/8">
      <div>
        <div className="flex min-h-10 items-center gap-1.5 px-3 py-1.5">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/70">
            <CornerDownRight size={12} />
          </span>
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
            {t("dictionary.groups.ungrouped")}
          </span>
          <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] tabular-nums text-muted-foreground">
            {t("dictionary.groups.itemCount", { count: ungroupedItems.length })}
          </span>
        </div>
        {ungroupedItems.length === 0 ? (
          <p className="pb-1.5 pl-8 text-[11px] text-muted-foreground/70">
            {t("dictionary.groups.emptyGroup")}
          </p>
        ) : (
          ungroupedItems.map((item) => renderItemRow(item))
        )}
      </div>
      {rootGroups.map((group) => renderGroup(group, 0))}
      {creatingParentId === null && renderInlineCreateRow(null, 0)}
      <div className="px-3 py-2">
        <button
          type="button"
          onClick={() => {
            setCreatingParentId(null);
            setCreateDraft("");
            setInlineError(null);
          }}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          <FolderPlus size={12} />
          {t("dictionary.groups.new")}
        </button>
      </div>
      {inlineError && (
        <p className="px-3 pb-2 text-[11px] text-destructive/90" role="alert">
          {inlineError}
        </p>
      )}
    </div>
  );
}
