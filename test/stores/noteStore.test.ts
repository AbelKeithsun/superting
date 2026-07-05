import assert from "node:assert/strict";
import test from "node:test";

function createNote(overrides = {}) {
  return {
    id: 42,
    title: "Project sync",
    content: "",
    enhanced_content: null,
    enhancement_prompt: null,
    enhanced_at_content_hash: null,
    note_type: "meeting",
    source_file: null,
    audio_duration_seconds: null,
    folder_id: 1,
    transcript: "Speaker: original transcript",
    participants: null,
    diarization_enabled: null,
    expected_speaker_count: null,
    cloud_id: null,
    recorded_at: "2026-06-13 10:00:00",
    created_at: "2026-06-13 10:00:00",
    updated_at: "2026-06-13 10:00:00",
    client_note_id: "client-42",
    sync_status: "synced",
    deleted_at: null,
    ...overrides,
  };
}

test("initial note loads do not overwrite a newer note update that arrived while loading", async () => {
  const staleNote = createNote();
  const savedNote = createNote({
    content: "# 会议纪要\n\n生成完成",
    updated_at: "2026-06-13 10:01:00",
  });

  let resolveGetNotes: (notes: unknown[]) => void = () => {};
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      electronAPI: {
        getNotes: async () =>
          new Promise((resolve) => {
            resolveGetNotes = resolve;
          }),
      },
    },
    configurable: true,
  });

  const { initializeNotes, updateNoteInStore, getNotesValue } =
    await import("../../src/stores/noteStore.ts");

  const loading = initializeNotes(null, 50, 1);
  updateNoteInStore(savedNote);
  resolveGetNotes([staleNote]);
  await loading;

  assert.equal(getNotesValue()[0]?.content, savedNote.content);
  assert.equal(getNotesValue()[0]?.updated_at, savedNote.updated_at);
});

test("deleted note update removes the note instead of re-adding it", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      electronAPI: {
        getNotes: async () => [createNote()],
      },
    },
    configurable: true,
  });

  const { initializeNotes, updateNoteInStore, getNotesValue } =
    await import("../../src/stores/noteStore.ts");

  await initializeNotes(null, 50, 1);
  updateNoteInStore(createNote({ deleted_at: "2026-06-21 10:00:00" }));

  assert.deepEqual(getNotesValue(), []);
});

test("appendNotesPage appends the next page without replacing the first page", async () => {
  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      electronAPI: {
        getNotes: async () => [createNote({ id: 1, title: "first" })],
      },
    },
    configurable: true,
  });

  const { initializeNotes, appendNotesPage, getNotesValue } =
    await import("../../src/stores/noteStore.ts");

  await initializeNotes(null, 50, null, "createdAt");
  appendNotesPage([createNote({ id: 2, title: "second" })], 2);

  assert.deepEqual(
    getNotesValue().map((note) => note.title),
    ["first", "second"]
  );
});

test("appendNotesPage deduplicates notes and preserves the newest version", async () => {
  const savedNote = createNote({
    id: 1,
    title: "saved",
    content: "newer local edit",
    updated_at: "2026-06-13 10:01:00",
  });
  const stalePageNote = createNote({
    id: 1,
    title: "stale",
    content: "older page",
    updated_at: "2026-06-13 10:00:00",
  });

  Object.defineProperty(globalThis, "window", {
    value: {
      addEventListener: () => {},
      electronAPI: {
        getNotes: async () => [savedNote],
      },
    },
    configurable: true,
  });

  const { initializeNotes, appendNotesPage, getNotesValue } =
    await import("../../src/stores/noteStore.ts");

  await initializeNotes(null, 50, null, "createdAt");
  appendNotesPage([stalePageNote, createNote({ id: 2, title: "second" })], 2);

  assert.equal(getNotesValue().length, 2);
  assert.equal(getNotesValue()[0]?.content, savedNote.content);
  assert.deepEqual(
    getNotesValue().map((note) => note.title),
    ["saved", "second"]
  );
});
