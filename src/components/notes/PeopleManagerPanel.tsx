import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Merge, Play, ChevronDown, ChevronRight, Trash2, X } from "lucide-react";
import type { PersonRecord, VoiceprintSegmentRecord } from "../../types/electron";

/**
 * Cross-meeting contact (people) management: edit name/email/phone/org/notes,
 * merge duplicates, delete a person, and manage local voiceprint templates.
 *
 * Voiceprint audition: a person with bound voiceprints can expand "voiceprint
 * segments" — the real-time audio slices of that person captured from meetings.
 * Each clip is click-to-play so the user can calibrate the binding by ear.
 * Multiple segments are supported per voiceprint.
 */
export default function PeopleManagerPanel() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState({
    displayName: "",
    email: "",
    phone: "",
    organization: "",
    notes: "",
  });
  const [mergeSourceId, setMergeSourceId] = useState<number | null>(null);
  // Voiceprint audition state: one expanded person at a time, with its
  // playable segments and lazily-resolved playback URLs.
  const [auditionPersonId, setAuditionPersonId] = useState<number | null>(null);
  const [auditionLoading, setAuditionLoading] = useState(false);
  const [segmentsByPerson, setSegmentsByPerson] = useState<
    Record<number, VoiceprintSegmentRecord[]>
  >({});
  const [playbackUrls, setPlaybackUrls] = useState<Record<number, string>>({});
  const [playbackLoading, setPlaybackLoading] = useState<Record<number, boolean>>({});
  const [playbackErrors, setPlaybackErrors] = useState<Record<number, string>>({});

  const refresh = useCallback(async (q = query) => {
    setLoading(true);
    const result = await window.electronAPI?.peopleList?.(q);
    setPeople(result?.people ?? []);
    setLoading(false);
  }, [query]);

  useEffect(() => {
    void refresh("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(query), 250);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const startEdit = (person: PersonRecord) => {
    setEditingId(person.id);
    setDraft({
      displayName: person.display_name,
      email: person.email || "",
      phone: person.phone || "",
      organization: person.organization || "",
      notes: person.notes || "",
    });
  };

  const saveEdit = async () => {
    if (editingId == null) return;
    await window.electronAPI?.peopleUpdate?.(editingId, {
      displayName: draft.displayName,
      email: draft.email.trim() || null,
      phone: draft.phone.trim() || null,
      organization: draft.organization.trim() || null,
      notes: draft.notes.trim() || null,
    });
    setEditingId(null);
    void refresh(query);
  };

  const deletePerson = async (id: number) => {
    await window.electronAPI?.peopleDelete?.(id);
    if (mergeSourceId === id) setMergeSourceId(null);
    if (auditionPersonId === id) {
      setAuditionPersonId(null);
      setSegmentsByPerson((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    void refresh(query);
  };

  const deleteVoiceprints = async (personId: number | null) => {
    await window.electronAPI?.voiceprintDeleteAll?.(personId);
    setSegmentsByPerson((prev) => {
      const next = { ...prev };
      if (personId != null) delete next[personId];
      return next;
    });
    void refresh(query);
  };

  const mergeInto = async (keepId: number) => {
    if (mergeSourceId == null || mergeSourceId === keepId) return;
    await window.electronAPI?.peopleMerge?.(keepId, mergeSourceId);
    setMergeSourceId(null);
    void refresh(query);
  };

  const toggleAudition = async (personId: number) => {
    if (auditionPersonId === personId) {
      setAuditionPersonId(null);
      return;
    }
    setAuditionPersonId(personId);
    if (segmentsByPerson[personId]) return;
    setAuditionLoading(true);
    try {
      const result = await window.electronAPI?.voiceprintSegmentList?.(personId);
      setSegmentsByPerson((prev) => ({ ...prev, [personId]: result?.segments ?? [] }));
    } finally {
      setAuditionLoading(false);
    }
  };

  const loadClip = async (segmentId: number) => {
    if (playbackUrls[segmentId]) return;
    setPlaybackLoading((prev) => ({ ...prev, [segmentId]: true }));
    setPlaybackErrors((prev) => {
      const next = { ...prev };
      delete next[segmentId];
      return next;
    });
    try {
      const result = await window.electronAPI?.getVoiceprintSegmentPlaybackUrl?.(segmentId);
      if (result?.success && result.url) {
        setPlaybackUrls((prev) => ({ ...prev, [segmentId]: result.url! }));
      } else {
        setPlaybackErrors((prev) => ({
          ...prev,
          [segmentId]: result?.error || t("contacts.clipUnavailable", "Clip unavailable"),
        }));
      }
    } finally {
      setPlaybackLoading((prev) => ({ ...prev, [segmentId]: false }));
    }
  };

  const inputClass =
    "h-7 w-full rounded border border-border/70 bg-surface-1/80 px-2 text-xs text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-ring/30";
  const peopleForMerge = useMemo(
    () => people.filter((p) => p.id !== mergeSourceId),
    [people, mergeSourceId]
  );

  const formatRange = (segment: VoiceprintSegmentRecord): string => {
    const start = Number(segment.start_seconds);
    const end = Number(segment.end_seconds);
    const fmt = (s: number) => {
      const m = Math.floor(s / 60);
      const sec = Math.floor(s % 60);
      return `${m}:${String(sec).padStart(2, "0")}`;
    };
    if (Number.isFinite(start)) {
      return Number.isFinite(end) && end > start
        ? `${fmt(start)} – ${fmt(end)}`
        : `${fmt(start)}+`;
    }
    return "";
  };

  return (
    <div className="space-y-3">
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("contacts.searchPlaceholder", "Search people...")}
        className={inputClass}
      />

      {loading ? (
        <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("contacts.loading", "Loading...")}
        </div>
      ) : people.length === 0 ? (
        <p className="px-1 py-2 text-xs text-muted-foreground">
          {t("contacts.empty", "No people yet. Add participants by name in a meeting note.")}
        </p>
      ) : (
        <div className="space-y-2">
          {people.map((person) => {
            const hasVoiceprints = (person.voiceprint_count ?? 0) > 0;
            const isAuditioning = auditionPersonId === person.id;
            const segments = segmentsByPerson[person.id] ?? [];
            return (
              <div
                key={person.id}
                data-person-id={person.id}
                className="rounded-lg border border-border/60 bg-background/60 p-2.5"
              >
                {editingId === person.id ? (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">
                          {t("contacts.fieldName", "Name")}
                        </span>
                        <input
                          value={draft.displayName}
                          onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">
                          {t("contacts.fieldEmail", "Email")}
                        </span>
                        <input
                          value={draft.email}
                          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">
                          {t("contacts.fieldPhone", "Phone")}
                        </span>
                        <input
                          value={draft.phone}
                          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] text-muted-foreground">
                          {t("contacts.fieldOrganization", "Organization")}
                        </span>
                        <input
                          value={draft.organization}
                          onChange={(e) => setDraft({ ...draft, organization: e.target.value })}
                          className={inputClass}
                        />
                      </label>
                    </div>
                    <label className="block space-y-1">
                      <span className="text-[10px] text-muted-foreground">
                        {t("contacts.fieldNotes", "Notes")}
                      </span>
                      <input
                        value={draft.notes}
                        onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                        className={inputClass}
                      />
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void saveEdit()}
                        className="h-7 rounded-md bg-foreground/8 px-2.5 text-xs font-medium text-foreground/75 hover:bg-foreground/12"
                      >
                        {t("contacts.save", "Save")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <X size={12} />
                        {t("contacts.cancel", "Cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {person.display_name}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {[
                          person.email,
                          person.phone,
                          person.organization,
                          t("contacts.voiceprints", {
                            defaultValue: "{{count}} voiceprint(s)",
                            count: person.voiceprint_count ?? 0,
                          }),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(person)}
                        className="rounded px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                      >
                        {t("contacts.edit", "Edit")}
                      </button>
                      <button
                        type="button"
                        title={t("contacts.mergeHint", "Merge this person into another")}
                        onClick={() => setMergeSourceId(person.id)}
                        className={`rounded px-1.5 py-1 hover:bg-foreground/5 ${
                          mergeSourceId === person.id
                            ? "text-amber-600"
                            : "text-muted-foreground hover:text-foreground"
                        }`}
                      >
                        <Merge size={13} />
                      </button>
                      {hasVoiceprints && (
                        <button
                          type="button"
                          title={t("contacts.deleteVoiceprints", "Delete voiceprints")}
                          onClick={() => void deleteVoiceprints(person.id)}
                          className="rounded px-1.5 py-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        >
                          🎙️
                        </button>
                      )}
                      <button
                        type="button"
                        title={t("contacts.deletePerson", "Delete person")}
                        onClick={() => void deletePerson(person.id)}
                        className="rounded px-1.5 py-1 text-muted-foreground hover:bg-foreground/5 hover:text-destructive"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                )}

                {hasVoiceprints && editingId !== person.id && (
                  <div className="mt-2 border-t border-border/50 pt-2">
                    <button
                      type="button"
                      onClick={() => void toggleAudition(person.id)}
                      className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                    >
                      {isAuditioning ? (
                        <ChevronDown size={12} />
                      ) : (
                        <ChevronRight size={12} />
                      )}
                      {t("contacts.voiceprintSegments", "Voiceprint segments")}
                      {segments.length > 0 && (
                        <span className="rounded bg-muted px-1 text-[10px] tabular-nums">
                          {segments.length}
                        </span>
                      )}
                    </button>

                    {isAuditioning && (
                      <div className="mt-2 space-y-1.5">
                        {auditionLoading ? (
                          <div className="flex items-center gap-2 px-1 py-1 text-[11px] text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" />
                            {t("contacts.loading", "Loading...")}
                          </div>
                        ) : segments.length === 0 ? (
                          <p className="px-1 py-1 text-[11px] text-muted-foreground">
                            {t(
                              "contacts.voiceprintSegmentsEmpty",
                              "No auditionable voiceprint clips yet. Clips are captured from meetings where this person spoke and the audio is retained."
                            )}
                          </p>
                        ) : (
                          segments.map((segment) => {
                            const url = playbackUrls[segment.id];
                            const isClipLoading = !!playbackLoading[segment.id];
                            const clipError = playbackErrors[segment.id];
                            return (
                              <div
                                key={segment.id}
                                className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/40 p-2"
                              >
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void loadClip(segment.id)}
                                    disabled={isClipLoading}
                                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                                    aria-label={t("contacts.playVoiceprintClip", "Play voiceprint clip")}
                                  >
                                    {isClipLoading ? (
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                    ) : (
                                      <Play size={11} />
                                    )}
                                  </button>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[11px] font-medium text-foreground">
                                      {segment.note_title ||
                                        t("contacts.unnamedNote", "Untitled note")}
                                    </div>
                                    {formatRange(segment) && (
                                      <div className="text-[10px] tabular-nums text-muted-foreground">
                                        {formatRange(segment)}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                {url && (
                                  <audio controls preload="none" className="h-8 w-full">
                                    <source src={url} type="audio/wav" />
                                  </audio>
                                )}
                                {clipError && (
                                  <p className="px-0.5 text-[10px] text-destructive/80">
                                    {clipError}
                                  </p>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}
                  </div>
                )}

                {mergeSourceId === person.id && peopleForMerge.length > 0 && (
                  <div className="mt-2 space-y-1 rounded-md border border-amber-300/40 bg-amber-50/50 p-2 dark:bg-amber-400/10">
                    <p className="text-[11px] text-amber-800 dark:text-amber-200">
                      {t("contacts.mergeIntoPrompt", "Merge into which person?")}
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {peopleForMerge.slice(0, 8).map((target) => (
                        <button
                          key={target.id}
                          type="button"
                          onClick={() => void mergeInto(target.id)}
                          className="rounded border border-amber-300/60 px-1.5 py-0.5 text-[11px] text-amber-900 hover:bg-amber-100 dark:text-amber-100 dark:hover:bg-amber-400/20"
                        >
                          {target.display_name}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setMergeSourceId(null)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                      >
                        {t("contacts.cancel", "Cancel")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t("contacts.voiceprintPrivacy", {
          defaultValue:
            "Voiceprints are biometric templates stored only on this device. They are never exported or synced.",
        })}
      </p>
    </div>
  );
}
