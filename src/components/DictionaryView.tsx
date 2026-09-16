import { useState, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, X, Info, ArrowRight, Search, Folder } from "lucide-react";
import { Input } from "./ui/input";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/dialog";
import { useToast } from "./ui/useToast";
import { cn } from "./lib/utils";
import { useSettings } from "../hooks/useSettings";
import type { DictionaryGroup } from "../hooks/useSettings";
import { getAgentName } from "../utils/agentName";
import {
  buildDictionaryDisplayItems,
  filterDictionaryDisplayItems,
  type DictionaryDisplayItem,
} from "../utils/dictionaryListItems";
import { resolveDictionaryInputSubmission } from "../utils/dictionaryInput";
import DictionaryGroupTree from "./dictionary/DictionaryGroupTree";
import DictionaryGroupPicker from "./dictionary/DictionaryGroupPicker";
import PeopleManagerPanel from "./notes/PeopleManagerPanel";

const FOCUS_WORD_STORAGE_KEY = "superting.dictionary.focusWord";

export default function DictionaryView() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const {
    customDictionary,
    customDictionaryAliases,
    dictionaryGroups,
    dictionaryGroupAssignments,
    setCustomDictionary,
    setCustomDictionaryAliases,
    refreshDictionaryGroups,
    createDictionaryGroup,
    renameDictionaryGroup,
    deleteDictionaryGroup,
    moveDictionaryItemToGroup,
    moveDictionaryGroupToParent,
    restoreDictionaryGroups,
  } = useSettings();
  const agentName = getAgentName();
  const [activeTab, setActiveTab] = useState<"dictionary" | "people">("dictionary");
  const [dictionarySearch, setDictionarySearch] = useState("");
  const [aliasFrom, setAliasFrom] = useState("");
  const [aliasTo, setAliasTo] = useState("");
  const [targetGroupId, setTargetGroupId] = useState<number | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<DictionaryGroup | null>(null);
  const [focusedItemId, setFocusedItemId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);

  useEffect(() => {
    void refreshDictionaryGroups();
  }, [refreshDictionaryGroups]);

  // External focus contract: the correction-learning pipeline drops a word
  // here so "词典" opens with that entry revealed and its move picker open.
  useEffect(() => {
    try {
      const word = localStorage.getItem(FOCUS_WORD_STORAGE_KEY);
      if (!word) return;
      localStorage.removeItem(FOCUS_WORD_STORAGE_KEY);
      setFocusedItemId(`word:${word}`);
    } catch {
      /* localStorage unavailable */
    }
  }, []);

  const dictionaryItems = useMemo(
    () =>
      buildDictionaryDisplayItems({
        dictionary: customDictionary,
        aliases: customDictionaryAliases,
      }),
    [customDictionary, customDictionaryAliases]
  );
  const filteredDictionaryItems = useMemo(
    () => filterDictionaryDisplayItems(dictionaryItems, dictionarySearch),
    [dictionaryItems, dictionarySearch]
  );
  const isDictionaryEmpty = dictionaryItems.length === 0;
  const hasSearchQuery = dictionarySearch.trim().length > 0;
  const activeTabDescription =
    activeTab === "dictionary" ? t("dictionary.dictionaryUsage") : t("dictionary.peopleUsage");
  const targetGroupName = useMemo(() => {
    if (targetGroupId == null) return t("dictionary.groups.ungrouped");
    return (
      dictionaryGroups.find((group) => group.id === targetGroupId)?.name ??
      t("dictionary.groups.ungrouped")
    );
  }, [dictionaryGroups, targetGroupId, t]);

  const handleRemove = useCallback(
    (word: string) => {
      if (word === agentName) return;
      setCustomDictionary(customDictionary.filter((w) => w !== word));
    },
    [customDictionary, setCustomDictionary, agentName]
  );

  const handleClearDictionary = useCallback(() => {
    // The dictionary rewrite already ungroups every surviving item; dropping the
    // folders as well keeps "clear all" predictable (deepest first so the
    // re-parenting inside deleteDictionaryGroup stays a no-op).
    const deepestFirst = [...dictionaryGroups].sort((a, b) => b.id - a.id);
    setCustomDictionary(customDictionary.filter((w) => w === agentName));
    setCustomDictionaryAliases([]);
    setDictionarySearch("");
    void (async () => {
      for (const group of deepestFirst) await deleteDictionaryGroup(group.id);
    })();
  }, [
    agentName,
    customDictionary,
    dictionaryGroups,
    deleteDictionaryGroup,
    setCustomDictionary,
    setCustomDictionaryAliases,
  ]);

  const handleSubmitDictionaryInput = useCallback(async () => {
    const submission = resolveDictionaryInputSubmission({
      source: aliasFrom,
      correction: aliasTo,
      dictionary: customDictionary,
      aliases: customDictionaryAliases,
    });

    if (submission.type === "words") {
      setCustomDictionary([...customDictionary, ...submission.words]);
      setAliasFrom("");
      if (targetGroupId != null) {
        for (const word of submission.words) {
          await moveDictionaryItemToGroup({ itemType: "word", key: word, groupId: targetGroupId });
        }
      }
      return;
    }

    if (submission.type === "alias") {
      if (submission.alias) {
        setCustomDictionaryAliases([...customDictionaryAliases, submission.alias]);
        if (targetGroupId != null) {
          await moveDictionaryItemToGroup({
            itemType: "alias",
            key: submission.alias.from,
            groupId: targetGroupId,
          });
        }
      }
      if (submission.shouldAddTargetWord) {
        setCustomDictionary([...customDictionary, aliasTo.trim()]);
        if (targetGroupId != null) {
          await moveDictionaryItemToGroup({
            itemType: "word",
            key: aliasTo.trim(),
            groupId: targetGroupId,
          });
        }
      }
      setAliasFrom("");
      setAliasTo("");
    }
  }, [
    aliasFrom,
    aliasTo,
    customDictionary,
    customDictionaryAliases,
    targetGroupId,
    moveDictionaryItemToGroup,
    setCustomDictionary,
    setCustomDictionaryAliases,
  ]);

  const handleRemoveAlias = useCallback(
    (from: string) => {
      setCustomDictionaryAliases(
        customDictionaryAliases.filter((alias) => alias.from.toLowerCase() !== from.toLowerCase())
      );
    },
    [customDictionaryAliases, setCustomDictionaryAliases]
  );

  const handleMoveItem = useCallback(
    (item: DictionaryDisplayItem, groupId: number | null) => {
      void moveDictionaryItemToGroup({
        itemType: item.type === "word" ? "word" : "alias",
        key: item.type === "word" ? item.word : item.from,
        groupId,
      });
    },
    [moveDictionaryItemToGroup]
  );

  const handleDeleteGroup = useCallback(
    async (group: DictionaryGroup) => {
      const result = await deleteDictionaryGroup(group.id);
      if (!result?.success) {
        toast({
          title: t("dictionary.groups.deleteFailed"),
          description: result?.error,
          variant: "destructive",
        });
        return;
      }
      const snapshot = result.snapshot;
      toast({
        title: t("dictionary.groups.deleted", { name: group.name }),
        description: t("dictionary.groups.deletedDescription", {
          children: result.reparentedCount ?? 0,
          items: result.ungroupedCount ?? 0,
        }),
        duration: 8000,
        action: snapshot ? (
          <button
            type="button"
            onClick={async () => {
              const restored = await restoreDictionaryGroups(snapshot);
              if (restored?.success) {
                toast({ title: t("dictionary.groups.restored", { name: group.name }) });
              }
            }}
            className="rounded-sm bg-foreground/5 px-2 py-1 text-[11px] font-medium text-foreground/75 transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            {t("dictionary.groups.undo")}
          </button>
        ) : undefined,
      });
    },
    [deleteDictionaryGroup, restoreDictionaryGroups, t, toast]
  );

  const pendingDeleteChildCount = pendingDeleteGroup
    ? dictionaryGroups.filter((group) => group.parentId === pendingDeleteGroup.id).length
    : 0;
  const pendingDeleteItemCount = pendingDeleteGroup
    ? Object.values(dictionaryGroupAssignments.words || {}).filter(
        (id) => id === pendingDeleteGroup.id
      ).length +
      Object.values(dictionaryGroupAssignments.aliases || {}).filter(
        (id) => id === pendingDeleteGroup.id
      ).length
    : 0;

  return (
    <div className="ow-workspace-page">
      <div className="ow-page-column">
        <ConfirmDialog
          open={confirmClear}
          onOpenChange={setConfirmClear}
          title={t("dictionary.clearTitle")}
          description={`${t("dictionary.clearDescription")} ${t("dictionary.groups.clearHint")}`}
          onConfirm={handleClearDictionary}
          variant="destructive"
        />
        <ConfirmDialog
          open={pendingDeleteGroup != null}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteGroup(null);
          }}
          title={t("dictionary.groups.deleteConfirmTitle", {
            name: pendingDeleteGroup?.name ?? "",
          })}
          description={t("dictionary.groups.deleteConfirmDescription", {
            name: pendingDeleteGroup?.name ?? "",
            children: pendingDeleteChildCount,
            items: pendingDeleteItemCount,
          })}
          onConfirm={() => {
            if (pendingDeleteGroup) void handleDeleteGroup(pendingDeleteGroup);
            setPendingDeleteGroup(null);
          }}
          variant="destructive"
        />

        <div className="ow-page-header">
          <div className="ow-page-heading">
            <h1 className="ow-page-title">{t("dictionary.title")}</h1>
            <p className="ow-page-description">{activeTabDescription}</p>
          </div>
          <div className="ow-segmented inline-flex shrink-0 text-xs">
            <button
              onClick={() => setActiveTab("dictionary")}
              className={`ow-segmented-item ${
                activeTab === "dictionary" ? "ow-segmented-item-active" : ""
              }`}
            >
              {t("dictionary.dictionary")}
            </button>
            <button
              onClick={() => setActiveTab("people")}
              className={`ow-segmented-item ${
                activeTab === "people" ? "ow-segmented-item-active" : ""
              }`}
            >
              {t("dictionary.people")}
            </button>
          </div>
        </div>

        <div className="ow-page-body">
          {activeTab === "people" ? (
            <div className="ow-section">
              <div className="ow-section-header">
                <div className="flex items-baseline gap-2">
                  <h2 className="ow-section-title">{t("dictionary.peopleTitle")}</h2>
                </div>
              </div>
              <div className="ow-section-muted">
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("dictionary.peopleDescription")}
                </p>
              </div>
              <div className="ow-section-flat">
                <PeopleManagerPanel />
              </div>
            </div>
          ) : (
            <div className="ow-section flex min-h-0 max-w-full flex-col p-0">
              <div className="ow-section-header mb-0 px-4 pt-4">
                <div className="flex items-baseline gap-2">
                  <h2 className="ow-section-title">{t("dictionary.title")}</h2>
                  <span className="text-xs text-muted-foreground font-mono tabular-nums">
                    {dictionaryItems.length}
                  </span>
                </div>
                {!isDictionaryEmpty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmClear(true)}
                    aria-label={t("dictionary.clearAll")}
                    className="text-xs text-muted-foreground hover:text-destructive"
                  >
                    {t("dictionary.clearAll")}
                  </Button>
                )}
              </div>

              <div className="ow-section-flat">
                <div className="relative">
                  <Search
                    size={14}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    aria-label={t("dictionary.searchAriaLabel")}
                    placeholder={t("dictionary.searchPlaceholder")}
                    value={dictionarySearch}
                    onChange={(e) => setDictionarySearch(e.target.value)}
                    className="h-9 pl-8 pr-8 text-xs"
                  />
                  {hasSearchQuery && (
                    <button
                      onClick={() => setDictionarySearch("")}
                      aria-label={t("dictionary.clearSearch")}
                      className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      <X size={12} strokeWidth={2} />
                    </button>
                  )}
                </div>
              </div>

              <div className="ow-section-divider ow-section-flat space-y-3">
                <div className="grid grid-cols-1 items-center gap-2 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
                  <Input
                    placeholder={t("dictionary.aliasFromPlaceholder")}
                    value={aliasFrom}
                    onChange={(e) => setAliasFrom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSubmitDictionaryInput();
                    }}
                    className="h-8 text-xs"
                  />
                  <ArrowRight size={13} className="hidden text-muted-foreground md:block" />
                  <Input
                    placeholder={t("dictionary.aliasToPlaceholder")}
                    value={aliasTo}
                    onChange={(e) => setAliasTo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void handleSubmitDictionaryInput();
                    }}
                    className="h-8 text-xs"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleSubmitDictionaryInput()}
                    disabled={!aliasFrom.trim()}
                    className="h-8 w-full px-3 text-xs md:w-auto"
                  >
                    {t("dictionary.aliasAdd")}
                  </Button>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 px-1">
                  <span className="text-[11px] text-muted-foreground">
                    {t("dictionary.groups.addTo")}
                  </span>
                  <DictionaryGroupPicker
                    groups={dictionaryGroups}
                    selectedGroupId={targetGroupId}
                    onSelect={(groupId) => setTargetGroupId(groupId)}
                    onCreateGroup={async (name, parentId) => {
                      const result = await createDictionaryGroup(name, parentId);
                      if (result?.success && result.groups) {
                        const created = result.groups.find(
                          (group) =>
                            group.name === name &&
                            (group.parentId ?? null) === (parentId ?? null)
                        );
                        if (created) setTargetGroupId(created.id);
                      }
                      return result;
                    }}
                    trigger={
                      <button
                        type="button"
                        className={cn(
                          "inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-background/75 px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border hover:bg-muted/70 hover:text-foreground",
                          targetGroupId != null && "text-foreground"
                        )}
                      >
                        <Folder size={10} />
                        {targetGroupName}
                      </button>
                    }
                  />
                </div>

                <div className="flex items-start gap-1.5 px-1">
                  <Info size={12} className="text-muted-foreground mt-px shrink-0" />
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t("dictionary.inputHint")}
                  </p>
                </div>
              </div>

              <div className="ow-section-divider min-h-0">
                {isDictionaryEmpty ? (
                  <div className="px-4 py-8 text-center">
                    <div className="ow-empty-state-visual mx-auto h-11 w-11">
                      <BookOpen size={17} strokeWidth={1.5} className="text-foreground/35" />
                    </div>
                    <h2 className="ow-empty-state-title">{t("dictionary.title")}</h2>
                    <p className="ow-empty-state-description mx-auto mb-5">
                      {t("dictionary.description")}
                    </p>
                    <div className="mx-auto flex max-w-[360px] flex-wrap items-center justify-center gap-1.5">
                      {["SuperTing", "Dr. Smith", "gRPC"].map((example) => (
                        <span
                          key={example}
                          className="text-xs text-muted-foreground px-2 py-1 rounded-md border border-border/70 bg-background"
                        >
                          {example}
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => setShowInfo(!showInfo)}
                      aria-expanded={showInfo}
                      aria-label={t("dictionary.howItWorks")}
                      className="mt-5 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mx-auto"
                    >
                      <Info size={9} />
                      {t("dictionary.howItWorks")}
                    </button>
                    {showInfo && (
                      <div className="mx-auto mt-2.5 max-w-[360px] rounded-md bg-muted/50 border border-border/70 px-3 py-2.5">
                        <p className="text-xs text-muted-foreground leading-[1.6]">
                          {t("dictionary.howItWorksDetail")}
                        </p>
                      </div>
                    )}
                  </div>
                ) : hasSearchQuery && filteredDictionaryItems.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm font-semibold text-foreground">
                      {t("dictionary.emptySearchTitle")}
                    </p>
                    <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                      {t("dictionary.emptySearchDescription")}
                    </p>
                  </div>
                ) : (
                  <DictionaryGroupTree
                    groups={dictionaryGroups}
                    assignments={dictionaryGroupAssignments}
                    items={dictionaryItems}
                    filteredItems={filteredDictionaryItems}
                    query={dictionarySearch}
                    agentName={agentName}
                    focusedItemId={focusedItemId}
                    onFocusHandled={() => setFocusedItemId(null)}
                    onRemoveWord={handleRemove}
                    onRemoveAlias={handleRemoveAlias}
                    onMoveItem={handleMoveItem}
                    onCreateGroup={(name, parentId) => createDictionaryGroup(name, parentId)}
                    onRenameGroup={(id, name) => renameDictionaryGroup(id, name)}
                    onDeleteGroup={(group) => setPendingDeleteGroup(group)}
                    onMoveGroup={(id, parentId) => moveDictionaryGroupToParent(id, parentId)}
                  />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
