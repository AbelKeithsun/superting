const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("note editor and list expose note tags", () => {
  const editor = read("src/components/notes/NoteEditor.tsx");
  const tagEditor = read("src/components/notes/NoteTagsEditor.tsx");
  const listItem = read("src/components/notes/NoteListItem.tsx");
  const notesView = read("src/components/notes/PersonalNotesView.tsx");

  assert.match(editor, /import NoteTagsEditor from "\.\/NoteTagsEditor"/);
  assert.match(editor, /onTagsChange/);
  assert.match(editor, /<NoteTagsEditor/);
  assert.match(editor, /availableTags=\{availableTags\}/);
  assert.ok(
    editor.indexOf('folderName || t("notes.editor.noFolder")') < editor.indexOf("<NoteTagsEditor"),
    "note tag control should render after the folder selector"
  );
  assert.match(tagEditor, /DropdownMenuCheckboxItem/);
  assert.match(tagEditor, /remainingTagCount/);
  assert.match(listItem, /note\.tags/);
  assert.match(notesView, /selectedTags/);
  assert.match(notesView, /DropdownMenuCheckboxItem/);
  assert.match(notesView, /selectedTagSummary/);
  assert.match(notesView, /visibleNotes\.map/);
  assert.match(notesView, /notes\.tags\.filterAll/);
  assert.match(notesView, /electronAPI\.getTags\(\)/);
  assert.doesNotMatch(notesView, /notes\.flatMap\(\(note\) => note\.tags/);
});

test("MCP integration renders the tool catalog returned by status", () => {
  const card = read("src/components/McpIntegrationCard.tsx");
  const english = JSON.parse(read("src/locales/en/translation.json"));
  const expectedTools = [
    "health",
    "list_notes",
    "search_notes",
    "get_note",
    "create_note",
    "update_note",
    "delete_note",
    "list_folders",
    "create_folder",
    "list_transcriptions",
    "get_transcription",
    "get_dictionary",
    "get_dictionary_aliases",
    "list_tags",
  ];

  assert.match(card, /tools:\s*Array<\{ name: string \}>/);
  assert.match(card, /status\.tools/);
  assert.match(card, /\(status\.tools \|\| \[\]\)\.map/);
  assert.match(card, /integrations\.mcp\.toolsTitle/);
  assert.match(card, /integrations\.mcp\.toolColumn/);
  assert.match(card, /integrations\.mcp\.descriptionColumn/);
  assert.match(card, /integrations\.mcp\.unknownToolDescription/);
  assert.match(card, /sm:grid-cols-/);
  assert.doesNotMatch(card, /migrationNotice/);

  assert.deepEqual(Object.keys(english.integrations.mcp.tools), expectedTools);
  for (const name of expectedTools) {
    assert.equal(typeof english.integrations.mcp.tools[name], "string");
    assert.ok(english.integrations.mcp.tools[name].length > 0);
  }
  for (const unsupported of ["get_usage", "get_note_transcript", "delete_transcription"]) {
    assert.equal(english.integrations.mcp.tools[unsupported], undefined);
  }
});

test("notes default to all folders and load 50 more at the bottom", () => {
  const notesView = read("src/components/notes/PersonalNotesView.tsx");
  const folderManagement = read("src/hooks/useFolderManagement.ts");
  const localeRoot = path.join(root, "src/locales");
  const locales = fs
    .readdirSync(localeRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  assert.match(notesView, /useState<NoteSortBy>\("createdAt"\)/);
  assert.match(notesView, /IntersectionObserver/);
  assert.match(notesView, /noteLimit \+ 50/);
  assert.match(notesView, /t\("notes\.folders\.all"\)/);
  assert.match(folderManagement, /setActiveFolderId\(null\)/);
  assert.match(folderManagement, /initializeNotes\(null, 50, null, "createdAt"\)/);
  assert.match(folderManagement, /getNote\(presetNoteId\)/);
  for (const locale of locales) {
    const translations = JSON.parse(read(`src/locales/${locale}/translation.json`));
    assert.ok(translations.notes.folders.all, `${locale} should translate notes.folders.all`);
  }
});
