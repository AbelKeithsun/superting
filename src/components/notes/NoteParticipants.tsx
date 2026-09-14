import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Users, X } from "lucide-react";
import { Popover, PopoverTrigger, PopoverContent } from "../ui/popover";
import type { PersonRecord } from "../../types/electron";

export interface NoteParticipant {
  // personId links the participant to a cross-meeting person record; email is
  // optional — a name alone is a valid participant.
  personId?: number;
  email?: string | null;
  displayName: string | null;
  display_name?: string | null;
  responseStatus?: string | null;
  optional?: boolean;
  self?: boolean;
}

const participantKey = (p: NoteParticipant): string =>
  p.personId != null ? `person:${p.personId}` : `email:${(p.email || "").toLowerCase()}`;

const isEmailText = (text: string): boolean => text.includes("@");

function getInitials(displayName: string | null, email?: string | null): string {
  if (displayName) return displayName.charAt(0).toUpperCase();
  return (email || "?").charAt(0).toUpperCase();
}

function getInitialColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 65%)`;
}

interface ParticipantAvatarProps {
  email?: string | null;
  displayName: string | null;
  gravatarHash?: string;
  failed: boolean;
  onImageError: () => void;
}

function ParticipantAvatar({
  email,
  displayName,
  gravatarHash,
  failed,
  onImageError,
}: ParticipantAvatarProps) {
  // Gravatar is only requested when the participant actually has an email.
  if (email && gravatarHash && !failed) {
    return (
      <img
        src={`https://www.gravatar.com/avatar/${gravatarHash}?d=404&s=64`}
        alt=""
        loading="lazy"
        className="shrink-0 w-6 h-6 rounded-full object-cover"
        onError={onImageError}
      />
    );
  }
  return (
    <span
      className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-medium text-white"
      style={{ backgroundColor: getInitialColor(displayName || email || "?") }}
    >
      {getInitials(displayName, email)}
    </span>
  );
}

interface NoteParticipantsProps {
  noteId: number;
  participants: NoteParticipant[];
}

export default function NoteParticipants({ noteId, participants }: NoteParticipantsProps) {
  const { t } = useTranslation();
  const [localParticipants, setLocalParticipants] = useState(participants);
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<
    Array<{ email: string; display_name: string | null }>
  >([]);
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [gravatarHashes, setGravatarHashes] = useState<Record<string, string>>({});
  const [failedGravatars, setFailedGravatars] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setLocalParticipants(participants);
  }, [participants]);

  useEffect(() => {
    if (!open) return;
    window.electronAPI?.peopleList?.("").then((result) => {
      if (result.success) setPeople(result.people);
    });
  }, [open]);

  useEffect(() => {
    const emails = localParticipants
      .map((p) => p.email)
      .filter((e): e is string => !!e && !gravatarHashes[e]);
    if (emails.length === 0) return;

    Promise.all(
      emails.map(async (email) => {
        const hash = await window.electronAPI.getMD5Hash(email);
        return { email, hash };
      })
    ).then((results) => {
      setGravatarHashes((prev) => {
        const next = { ...prev };
        for (const { email, hash } of results) next[email] = hash;
        return next;
      });
    });
  }, [localParticipants, gravatarHashes]);

  useEffect(() => {
    if (!open) return;
    const query = search.trim();
    window.electronAPI.searchContacts(query).then((result) => {
      if (result.success) {
        const existing = new Set(
          localParticipants.map((p) => (p.email || "").toLowerCase()).filter(Boolean)
        );
        setSuggestions(result.contacts.filter((c) => !existing.has(c.email.toLowerCase())));
      }
    });
  }, [search, open, localParticipants]);

  const saveParticipants = useCallback(
    (updated: NoteParticipant[]) => {
      window.electronAPI.updateNote(noteId, {
        participants: JSON.stringify(updated),
      });
    },
    [noteId]
  );

  const addEmailParticipant = useCallback(
    (email: string, displayName?: string | null) => {
      const normalized = email.toLowerCase().trim();
      if (!normalized) return;
      if (localParticipants.some((p) => (p.email || "").toLowerCase() === normalized)) return;

      // An email participant links to the matching person record when one
      // exists (or is created), so voiceprints carry across meetings.
      const existingPerson = people.find(
        (person) => (person.email || "").toLowerCase() === normalized
      );
      const linkPerson = existingPerson
        ? Promise.resolve(existingPerson)
        : window.electronAPI
            ?.peopleCreate?.({ displayName: displayName || normalized.split("@")[0], email: normalized })
            .then((result) => result.person)
            .catch(() => undefined);

      const updated: NoteParticipant[] = [
        ...localParticipants,
        {
          personId: existingPerson?.id,
          email: normalized,
          displayName: displayName || null,
          responseStatus: null,
          self: false,
        },
      ];
      setLocalParticipants(updated);
      saveParticipants(updated);
      window.electronAPI.upsertContact({ email: normalized, displayName: displayName || null });
      setSearch("");

      void linkPerson?.then((person) => {
        if (!person) return;
        const withPersonId: NoteParticipant[] = updated.map((p) =>
          p.email === normalized && p.personId == null ? { ...p, personId: person.id } : p
        );
        setLocalParticipants(withPersonId);
        saveParticipants(withPersonId);
        setPeople((prev) => (prev.some((x) => x.id === person.id) ? prev : [person, ...prev]));
      });
    },
    [localParticipants, saveParticipants, people]
  );

  // Name-first add: Enter with a plain name creates (or reuses) a person and
  // adds them with just a personId — no email required.
  const addNameParticipant = useCallback(
    async (rawName: string) => {
      const name = rawName.trim();
      if (!name) return;
      if (
        localParticipants.some(
          (p) => (p.displayName || "").toLowerCase() === name.toLowerCase()
        )
      ) {
        setSearch("");
        return;
      }

      let person = people.find((x) => x.display_name.toLowerCase() === name.toLowerCase());
      if (!person) {
        const result = await window.electronAPI?.peopleCreate?.({ displayName: name });
        if (result?.success && result.person) {
          person = result.person;
          setPeople((prev) => [person as PersonRecord, ...prev]);
        }
      }
      if (!person) return;

      const updated: NoteParticipant[] = [
        ...localParticipants,
        { personId: person.id, email: null, displayName: person.display_name, responseStatus: null, self: false },
      ];
      setLocalParticipants(updated);
      saveParticipants(updated);
      setSearch("");
    },
    [localParticipants, saveParticipants, people]
  );

  const removeParticipant = useCallback(
    (key: string) => {
      const updated = localParticipants.filter((p) => participantKey(p) !== key);
      setLocalParticipants(updated);
      saveParticipants(updated);
    },
    [localParticipants, saveParticipants]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" || !search.trim()) return;
      e.preventDefault();
      if (isEmailText(search)) {
        addEmailParticipant(search);
      } else {
        void addNameParticipant(search);
      }
    },
    [search, addEmailParticipant, addNameParticipant]
  );

  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people]
  );

  // Group by organization when known; email domain as a legacy fallback;
  // otherwise an ungrouped bucket.
  const grouped = useMemo(() => {
    const groups = new Map<string, NoteParticipant[]>();
    for (const p of localParticipants) {
      const person = p.personId != null ? peopleById.get(p.personId) : undefined;
      const label =
        (person?.organization || "").trim() ||
        (p.email ? p.email.split("@")[1] || "" : "") ||
        t("contacts.ungrouped", "Ungrouped");
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label)!.push(p);
    }
    return Array.from(groups.entries());
  }, [localParticipants, peopleById, t]);

  const chipLabel =
    localParticipants.length > 0
      ? `${localParticipants.length} ${localParticipants.length === 1 ? t("notes.participants.attendee", "attendee") : t("notes.participants.attendees", "attendees")}`
      : t("notes.participants.addAttendees", "Add attendees");

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button className="inline-flex h-6 max-w-40 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-border/70 bg-background/75 px-2 text-[11px] font-medium text-muted-foreground transition-colors duration-150 hover:border-border hover:bg-muted/70 hover:text-foreground cursor-pointer outline-none">
          <Users size={11} className="shrink-0" />
          <span className="truncate">{chipLabel}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0">
        <div className="p-2 border-b border-border/50">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("contacts.addPlaceholder", "Add by name or email...")}
            className="w-full px-2 py-1.5 rounded-md bg-transparent text-xs text-foreground placeholder:text-foreground/20 outline-none border-none appearance-none"
            autoFocus
          />
        </div>

        <div className="max-h-64 overflow-y-auto">
          {search && suggestions.length > 0 && (
            <div className="p-1 border-b border-border/30">
              {suggestions.slice(0, 5).map((contact) => (
                <button
                  key={contact.email}
                  onClick={() => addEmailParticipant(contact.email, contact.display_name)}
                  className="flex items-center gap-2 w-full px-2 py-1.5 rounded-md text-xs text-foreground/70 hover:bg-foreground/5 transition-colors cursor-pointer"
                >
                  <ParticipantAvatar
                    email={contact.email}
                    displayName={contact.display_name}
                    failed={false}
                    onImageError={() => {}}
                  />
                  <span className="truncate">{contact.display_name || contact.email}</span>
                </button>
              ))}
            </div>
          )}

          {search.trim() && suggestions.length === 0 && !isEmailText(search) && (
            <div className="px-3 py-2 text-[11px] text-foreground/30">
              {t("contacts.pressEnterToadd", "Press Enter to add “{{name}}”", { name: search.trim() })}
            </div>
          )}

          {grouped.map(([label, members]) => (
            <div key={label} className="p-1">
              <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                {label}
              </div>
              {members.map((p) => (
                <div
                  key={participantKey(p)}
                  className="group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-foreground/5 transition-colors"
                >
                  <ParticipantAvatar
                    email={p.email}
                    displayName={p.displayName}
                    gravatarHash={p.email ? gravatarHashes[p.email] : undefined}
                    failed={p.email ? failedGravatars.has(p.email) : true}
                    onImageError={() =>
                      p.email &&
                      setFailedGravatars((prev) => new Set(prev).add(p.email as string))
                    }
                  />

                  <span className="flex-1 min-w-0 truncate text-xs text-foreground/70">
                    {p.displayName || (p.email ? p.email.split("@")[0] : "")}
                    {p.self && (
                      <span className="ml-1 text-foreground/30">
                        {t("notes.participants.me", "(me)")}
                      </span>
                    )}
                  </span>

                  <button
                    onClick={() => removeParticipant(participantKey(p))}
                    className="shrink-0 opacity-0 group-hover:opacity-100 p-0.5 rounded text-foreground/30 hover:text-foreground/60 transition-opacity cursor-pointer"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          ))}

          {localParticipants.length === 0 && !search && (
            <div className="px-3 py-4 text-center text-[11px] text-foreground/30">
              {t("contacts.emptyHint", "Type a name or email to add participants")}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
