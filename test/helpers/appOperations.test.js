"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const z = require("zod/v4");

const { createRegistry, normalizeParams, OperationError } = require("../../src/helpers/appOperations/registry");
const { coreOperations } = require("../../src/helpers/appOperations/coreOperations");
const { actionOperations } = require("../../src/helpers/appOperations/actionOperations");
const { domainOperations } = require("../../src/helpers/appOperations/domainOperations");
const { buildZodShape, annotationsFor } = require("../../src/helpers/appOperations/mcpAdapter");
const { buildCliRoutes, collectParams, matchPath } = require("../../src/helpers/appOperations/cliAdapter");
const { listMcpToolNames } = require("../../src/helpers/appOperations");
const {
  OUTPUT_PATH,
  renderOperationsDoc,
} = require("../../scripts/generate-app-operations-docs.js");

/**
 * The surfaces used to be written by hand and had drifted: MCP could not write
 * dictionary entries, its search skipped the semantic index, the bridge exposed
 * two transcription deletes no CLI command called, and neither surface could run
 * a note action. These tests pin the contract that prevents a repeat.
 */

/** Tool names MCP clients could already rely on — none may disappear. */
const LEGACY_MCP_TOOLS = [
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

/** Route table the agent CLI (and its skills docs) shipped with. */
const LEGACY_CLI_ROUTES = [
  "GET /v1/health",
  "GET /v1/notes/list",
  "GET /v1/notes/search",
  "GET /v1/notes/:id",
  "POST /v1/notes/create",
  "PATCH /v1/notes/:id",
  "DELETE /v1/notes/:id",
  "GET /v1/folders/list",
  "POST /v1/folders/create",
  "GET /v1/dictionary",
  "PUT /v1/dictionary",
  "POST /v1/dictionary/words",
  "DELETE /v1/dictionary/words",
  "GET /v1/dictionary/aliases",
  "PUT /v1/dictionary/aliases",
  "POST /v1/dictionary/aliases",
  "DELETE /v1/dictionary/aliases",
  "GET /v1/tags",
  "GET /v1/transcriptions/list",
  "GET /v1/transcriptions/:id",
  "DELETE /v1/transcriptions/:id",
  "DELETE /v1/transcriptions/:id/audio",
];

function buildRegistry() {
  return createRegistry([...coreOperations(), ...actionOperations(), ...domainOperations()]);
}

test("every registered operation is exposed on both machine surfaces", () => {
  const registry = buildRegistry();
  const missing = registry
    .list()
    .filter((operation) => !operation.mcp || !operation.cli)
    .map((operation) => `${operation.id} (${operation.excludeReason ?? "no reason given"})`);

  assert.deepEqual(
    missing,
    [],
    `operations hidden from a surface need an explicit excludeReason: ${missing.join(", ")}`
  );
});

test("historical MCP tools and CLI routes are still present", () => {
  const registry = buildRegistry();
  const toolNames = registry
    .list()
    .filter((operation) => operation.mcp)
    .map((operation) => operation.mcp.name);
  for (const name of LEGACY_MCP_TOOLS) {
    assert.ok(toolNames.includes(name), `MCP tool ${name} disappeared`);
  }

  const routes = new Set(
    registry
      .list()
      .filter((operation) => operation.cli)
      .map((operation) => `${operation.cli.method} ${operation.cli.path}`)
  );
  for (const route of LEGACY_CLI_ROUTES) {
    assert.ok(routes.has(route), `CLI route ${route} disappeared`);
  }
});

test("the parity fixes are real: dictionary writes, semantic search and action runs", () => {
  const registry = buildRegistry();
  const names = listMcpToolNames();

  // MCP could read the dictionary but never write it.
  for (const tool of [
    "set_dictionary",
    "add_dictionary_words",
    "remove_dictionary_words",
    "set_dictionary_aliases",
    "add_dictionary_alias",
    "remove_dictionary_aliases",
    "delete_transcription",
    "delete_transcription_audio",
    "run_note_action",
    "export_note",
  ]) {
    assert.ok(names.includes(tool), `${tool} should be exposed to MCP`);
  }

  const search = registry.get("notes.search");
  assert.ok(search.params.semantic, "search_notes must be able to use the semantic index");
  assert.equal(search.cli.aliases.q, "query", "the CLI's `?q=` must keep working");

  const run = registry.get("actions.run");
  assert.equal(run.rendererRequired, true);
  assert.equal(run.policy, "write");
});

test("policy drives MCP annotations and destructive routes", () => {
  const registry = buildRegistry();
  assert.deepEqual(annotationsFor(registry.get("notes.list")), {
    readOnlyHint: true,
    destructiveHint: false,
  });
  assert.deepEqual(annotationsFor(registry.get("notes.delete")), {
    readOnlyHint: false,
    destructiveHint: true,
  });
  assert.equal(registry.get("notes.delete").cli.noContent, true);
  assert.equal(registry.get("notes.create").cli.status, 201);
});

test("params are normalized the same way for CLI strings and MCP values", () => {
  const operation = buildRegistry().get("notes.list");

  assert.deepEqual(normalizeParams(operation, {}), {});
  assert.deepEqual(normalizeParams(operation, { note_type: "meeting" }), { note_type: "meeting" });
  assert.equal(normalizeParams(operation, { limit: "25" }).limit, 25);
  assert.equal(normalizeParams(operation, { limit: 25 }).limit, 25);
  assert.deepEqual(normalizeParams(operation, { tags: "a,b" }).tags, ["a", "b"]);
  assert.deepEqual(normalizeParams(operation, { tags: ["a"] }).tags, ["a"]);
  assert.throws(() => normalizeParams(operation, { limit: "many" }), OperationError);

  const search = buildRegistry().get("notes.search");
  assert.throws(() => normalizeParams(search, { limit: 3 }), /"query" is required/);
  assert.throws(() => normalizeParams(search, { query: "x", semantic: "maybe" }), /Invalid boolean/);

  const format = buildRegistry().get("notes.export");
  assert.throws(() => normalizeParams(format, { id: 1, format: "docx" }), /must be one of/);
});

test("CLI routes collect path, query, repeatable and body parameters", () => {
  const registry = buildRegistry();
  const routes = buildCliRoutes(registry, {});
  const byId = new Map(routes.map((route) => [route.operationId, route]));

  assert.deepEqual(matchPath("/v1/notes/:id", "/v1/notes/42"), { id: "42" });
  assert.equal(matchPath("/v1/notes/:id", "/v1/notes/42/export"), null);
  assert.deepEqual(matchPath("/v1/notes/list", "/v1/notes/list"), {});
  assert.equal(matchPath("/v1/notes/list", "/v1/notes/42"), null, "static routes must not capture id-like paths");

  const getNote = byId.get("notes.get");
  assert.deepEqual(getNote.match("/v1/notes/7"), { id: "7" });

  const listNotes = byId.get("notes.list");
  const listParams = collectParams(registry.get("notes.list"), {
    params: {},
    query: new URLSearchParams("limit=5&tags=work&tags=urgent"),
    body: {},
  });
  assert.equal(listParams.limit, "5");
  assert.deepEqual(listParams.tags, ["work", "urgent"]);

  // `?q=` is the alias the CLI client has always sent.
  const searchParams = collectParams(registry.get("notes.search"), {
    params: {},
    query: new URLSearchParams("q=季度营收&semantic=true"),
    body: {},
  });
  assert.equal(searchParams.query, "季度营收");
  assert.equal(searchParams.semantic, "true");

  // `?word=a&word=b` is the wire format for dictionary removal.
  const removeWords = collectParams(registry.get("dictionary.remove_words"), {
    params: {},
    query: new URLSearchParams("word=foo&word=bar"),
    body: {},
  });
  assert.deepEqual(removeWords.words, ["foo", "bar"]);

  const createNote = collectParams(registry.get("notes.create"), {
    params: {},
    query: new URLSearchParams(),
    body: { title: "T", content: "C" },
  });
  assert.deepEqual(createNote, { title: "T", content: "C" });
});

test("MCP tool schemas derive from the declared params", () => {
  const registry = buildRegistry();
  const shape = buildZodShape(registry.get("notes.list"), z);
  assert.deepEqual(Object.keys(shape), ["limit", "folder_id", "note_type", "tags"]);
  assert.equal(shape.limit.safeParse(5).success, true);
  assert.equal(shape.limit.safeParse("5").success, false, "MCP values are typed, not strings");
  assert.equal(shape.limit.safeParse(undefined).success, true, "optional");

  const exportShape = buildZodShape(registry.get("notes.export"), z);
  assert.equal(exportShape.format.safeParse("md").success, true);
  assert.equal(exportShape.format.safeParse("docx").success, false);

  const runShape = buildZodShape(registry.get("actions.run"), z);
  assert.equal(runShape.id.safeParse(3).success, true);
  assert.equal(runShape.note_id.safeParse("3").success, false);
});

test("handlers run with the registry context and shape their own response", async () => {
  const registry = buildRegistry();
  const calls = [];
  const context = {
    db: {
      getNotes: (...args) => {
        calls.push(args);
        return [{ id: 1, title: "Note" }];
      },
      getDictionary: () => ["alpha"],
    },
    ipc: { semanticSearchNotes: async () => [] },
    broadcast: () => {},
  };

  const listed = await registry.invoke("notes.list", { limit: "5", tags: ["x"] }, context);
  assert.deepEqual(calls[0], [null, 5, null, "updatedAt", ["x"]]);
  assert.equal(listed.data.length, 1);
  assert.equal(listed.has_more, false);

  const mcpShaped = registry.get("notes.list").mcp.serialize(listed, {});
  assert.equal(mcpShaped.success, true);
  assert.equal(mcpShaped.data[0].content, "");
  assert.equal(mcpShaped.data[0].title, "Note");

  await assert.rejects(
    () => registry.invoke("notes.get", { id: 9 }, { db: { getNote: () => null } }),
    /Note 9 not found/
  );
  await assert.rejects(() => registry.invoke("notes.unknown", {}, context), /Unknown operation/);
});

test("the generated capability reference is up to date", () => {
  const rendered = renderOperationsDoc(buildRegistry().list());
  const existing = fs.readFileSync(OUTPUT_PATH, "utf8");
  assert.equal(
    existing,
    rendered,
    "agent-skills/superting-api/references/operations.md is stale — run `node scripts/generate-app-operations-docs.js`"
  );
  assert.ok(path.isAbsolute(OUTPUT_PATH) || OUTPUT_PATH.includes("operations.md"));
});

test("capabilities that need the UI are marked as such", () => {
  const registry = buildRegistry();
  const rendererOps = registry
    .list()
    .filter((operation) => operation.rendererRequired)
    .map((operation) => operation.id)
    .sort();

  assert.deepEqual(rendererOps, [
    "actions.run",
    "notes.export_files",
    "recording.start",
    "recording.status",
    "recording.stop",
    "settings.get",
    "settings.set",
    "transcriptions.retry",
  ]);
  // A renderer-required capability must still exist on both machine surfaces so
  // callers get a clear "renderer_unavailable" instead of a missing tool.
  for (const operation of registry.list().filter((op) => op.rendererRequired)) {
    assert.ok(operation.mcp && operation.cli, `${operation.id} must be on both surfaces`);
  }
});

test("IPC-backed operations call the registered handler channel with mapped args", async () => {
  const { unwrapIpcResult } = require("../../src/helpers/appOperations/domainOperations.js");
  const registry = buildRegistry();

  const calls = [];
  const context = {
    ipc: {
      invokeChannel: async (channel, ...args) => {
        calls.push([channel, ...args]);
        if (channel === "people-list") return { success: true, people: [{ id: 1 }] };
        if (channel === "db-hard-delete-conversation") return undefined;
        if (channel === "compress-note-audio") return { success: true };
        return { success: false, error: "boom" };
      },
    },
    renderer: { invoke: async () => ({}) },
    db: {},
    broadcast: () => {},
  };

  const people = await registry.invoke("people.list", { query: "anna" }, context);
  assert.deepEqual(calls[0], ["people-list", "anna"]);
  assert.deepEqual(people.data, [{ id: 1 }]);

  const audio = await registry.invoke(
    "notes.audio.compress",
    { id: 4, audio_file_id: 9 },
    context
  );
  assert.deepEqual(calls[1], ["compress-note-audio", 4, 9]);
  assert.deepEqual(audio.data, {});

  // Handler-level failures become operation errors, not silent empty payloads.
  await assert.rejects(
    () => registry.invoke("audio.usage", {}, context),
    /boom/
  );

  // Renderer-required operations go through the bridge with the mapped payload.
  let rendererCall = null;
  const rendererContext = {
    renderer: {
      invoke: async (channel, payload) => {
        rendererCall = [channel, payload];
        return { isRecording: false };
      },
    },
  };
  const status = await registry.invoke("recording.status", {}, rendererContext);
  assert.deepEqual(rendererCall, ["recording.status", {}]);
  assert.deepEqual(status.data, { isRecording: false });

  // Envelopes are unwrapped consistently.
  assert.deepEqual(unwrapIpcResult({ success: true, files: [1, 2] }), [1, 2]);
  assert.deepEqual(unwrapIpcResult([1, 2]), [1, 2]);
  assert.deepEqual(unwrapIpcResult({ success: true }), {});
  assert.throws(() => unwrapIpcResult({ success: false, error: "nope" }), /nope/);
});

test("setting a credential from an agent surface is refused by design", () => {
  const settingsOps = buildRegistry().get("settings.set");
  assert.equal(settingsOps.policy, "write");
  // The guard itself lives in the renderer handler; assert the contract here so
  // a future rewrite cannot silently drop it.
  const handlerSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "src", "stores", "appOperationHandlers.ts"),
    "utf8"
  );
  assert.match(handlerSource, /holds a credential/);
  assert.match(handlerSource, /SECRET_KEY_PATTERN/);
});

test("UI-bound operations fail cleanly outside Electron instead of crashing", async () => {
  const { RendererBridge } = require("../../src/helpers/appOperations/rendererBridge.js");
  assert.equal(RendererBridge.isAvailable(), false, "the test runner has no electron ipcMain");

  const bridge = new RendererBridge();
  await assert.rejects(
    () => bridge.invoke("run_note_action", {}),
    (error) => error.code === "UNAVAILABLE" && /window/i.test(error.message)
  );
});

test("the settings mirror round-trips redacted values", () => {
  const os = require("node:os");
  const { SettingsMirror, sanitize } = require("../../src/helpers/settingsMirror.js");
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "superting-mirror-"));
  try {
    const mirror = new SettingsMirror({ homeDir });
    const written = mirror.write({
      uiLanguage: "zh-CN",
      notifyUpdates: true,
      audioRetentionDays: 30,
      openaiApiKey: "sk-live-should-never-be-written",
      customDictionary: ["SuperTing"],
    });
    assert.equal(written.count, 5);

    const reloaded = new SettingsMirror({ homeDir });
    const snapshot = reloaded.read();
    assert.equal(snapshot.uiLanguage, "zh-CN");
    assert.equal(snapshot.notifyUpdates, true);
    assert.equal(snapshot.audioRetentionDays, 30);
    assert.deepEqual(snapshot.customDictionary, ["SuperTing"]);
    assert.equal(snapshot.openaiApiKey, "<redacted>");
    assert.equal(reloaded.read("uiLanguage"), "zh-CN");
    assert.equal(reloaded.info().count, 5);

    // Defence in depth: even a direct write cannot leak a credential.
    assert.equal(sanitize({ bedrockSecretAccessKey: "x" }).bedrockSecretAccessKey, "<redacted>");
    assert.match(reloaded.info().path, /settings-mirror\.json$/);
  } finally {
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
});

test("reading settings falls back to the mirror when no window is open", async () => {
  const registry = buildRegistry();
  const unavailable = Object.assign(new Error("no window"), { code: "UNAVAILABLE" });
  const context = {
    renderer: { invoke: async () => { throw unavailable; } },
    ipc: {
      getSettingsMirror: () => ({
        read: (key) => (key ? { uiLanguage: "zh-CN" }[key] : { uiLanguage: "zh-CN", notifyUpdates: true }),
      }),
    },
  };

  const all = await registry.invoke("settings.get", {}, context);
  assert.equal(all.data.source, "settings-mirror");
  assert.equal(all.data.count, 2);

  const one = await registry.invoke("settings.get", { key: "uiLanguage" }, context);
  assert.deepEqual(one.data, { key: "uiLanguage", value: "zh-CN", source: "settings-mirror" });

  await assert.rejects(
    () => registry.invoke("settings.get", { key: "nope" }, context),
    /Unknown setting/
  );

  // Without a mirror there is nothing to read: say so instead of guessing.
  await assert.rejects(
    () =>
      registry.invoke("settings.get", {}, {
        renderer: { invoke: async () => { throw unavailable; } },
        ipc: { getSettingsMirror: () => ({ read: () => null }) },
      }),
    /no settings snapshot/i
  );

  // Writing settings still needs the UI (the renderer owns the side effects).
  await assert.rejects(
    () => registry.invoke("settings.set", { key: "uiLanguage", value: "en" }, context),
    /no window/
  );
});
