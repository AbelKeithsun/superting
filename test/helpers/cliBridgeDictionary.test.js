const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const CliBridge = require("../../src/helpers/cliBridge");

function createTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superting-clip-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function createIpcHandlers() {
  const state = {
    dictionary: ["Existing"],
    aliases: [{ from: "foo", to: "bar" }],
    savedNoteArgs: null,
    broadcasts: [],
  };
  const notes = new Map();

  return {
    state,
    databaseManager: {
      getNotes: () => [],
      searchNotes: () => [],
      getNote: (id) => notes.get(id) || null,
      saveNote: (title, content, noteType, sourceFile, duration, folderId, transcript, tags) => {
        state.savedNoteArgs = {
          title,
          content,
          noteType,
          sourceFile,
          duration,
          folderId,
          transcript,
          tags,
        };
        const note = {
          id: 1,
          title,
          content,
          note_type: noteType,
          folder_id: folderId,
          tags: Array.isArray(tags) ? tags : [],
          deleted_at: null,
        };
        notes.set(1, note);
        return { success: true, note };
      },
      updateNote: (id, updates) => {
        const note = notes.get(id);
        if (!note) return { success: false };
        Object.assign(note, updates);
        return { success: true, note };
      },
      getFolders: () => [],
      createFolder: (name) => ({ success: true, folder: { id: 9, name } }),
      getTags: () => ["alpha", "beta"],
      getDictionary: () => [...state.dictionary],
      setDictionary: (words) => {
        state.dictionary = words.filter((w) => typeof w === "string" && w.trim());
        return { success: true };
      },
      getDictionaryAliases: () => state.aliases.map((a) => ({ ...a })),
      setDictionaryAliases: (aliases) => {
        state.aliases = (Array.isArray(aliases) ? aliases : [])
          .filter((a) => a?.from && a?.to && a.from.toLowerCase() !== a.to.toLowerCase())
          .map((a) => ({ from: a.from.trim(), to: a.to.trim() }));
        return { success: true };
      },
      getTranscriptions: () => [],
      getTranscriptionById: () => null,
    },
    broadcastToWindows: (channel, payload) => {
      state.broadcasts.push({ channel, payload });
    },
    _asyncVectorUpsert: () => {},
    _asyncMirrorWrite: () => {},
    deleteNoteInternal: (id) => (notes.has(id) ? { success: true } : { success: false }),
  };
}

async function startBridge(t, ipcHandlers) {
  const home = createTempHome(t);
  const bridge = new CliBridge(ipcHandlers, {
    bridgeFilePath: path.join(home, "cli-bridge.json"),
    portFinder: ephemeralPort,
  });
  await bridge.start();
  t.after(() => bridge.stop());
  return {
    bridge,
    url: `http://127.0.0.1:${bridge.port}`,
    token: bridge.token,
  };
}

function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function jsonOf(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

test("CLI bridge exposes dictionary and alias read endpoints for local agents", async () => {
  const bridge = new CliBridge({
    databaseManager: {
      getDictionary: () => ["EntVerse", "SuperTing"],
      getDictionaryAliases: () => [{ from: "Antibus", to: "EntVerse" }],
    },
  });

  const dictionaryRoute = bridge._matchRoute("GET", "/v1/dictionary");
  const aliasesRoute = bridge._matchRoute("GET", "/v1/dictionary/aliases");

  assert.ok(dictionaryRoute);
  assert.ok(aliasesRoute);
  assert.deepEqual(await dictionaryRoute.handler({ query: new URLSearchParams() }), {
    data: ["EntVerse", "SuperTing"],
  });
  assert.deepEqual(await aliasesRoute.handler({ query: new URLSearchParams() }), {
    data: [{ from: "Antibus", to: "EntVerse" }],
  });
});

test("dictionary words can be added with case-insensitive dedupe", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/dictionary/words`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ words: ["existing", "NewWord", "newword"] }),
  });
  assert.equal(response.status, 200);
  const payload = await jsonOf(response);
  assert.deepEqual(payload.data.added, ["NewWord"]);
  assert.deepEqual(payload.data.dictionary, ["Existing", "NewWord"]);

  await new Promise((resolve) => setImmediate(resolve));
  const dictBroadcast = ipc.state.broadcasts.find((b) => b.channel === "dictionary-updated");
  assert.ok(dictBroadcast, "expected a dictionary-updated broadcast");
  assert.deepEqual(dictBroadcast.payload, ["Existing", "NewWord"]);
});

test("dictionary words can be removed via repeated word query params", async (t) => {
  const ipc = createIpcHandlers();
  ipc.state.dictionary = ["Keep", "DropA", "dropb", "Other"];
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(
    `${url}/v1/dictionary/words?word=${encodeURIComponent("dropa")}&word=${encodeURIComponent("DropB")}`,
    { method: "DELETE", headers: authHeaders(token) }
  );
  assert.equal(response.status, 200);
  const payload = await jsonOf(response);
  assert.deepEqual(payload.data.removed.sort(), ["DropA", "dropb"]);
  assert.deepEqual(payload.data.dictionary, ["Keep", "Other"]);
});

test("dictionary full replace validates payload shape", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const bad = await fetch(`${url}/v1/dictionary`, {
    method: "PUT",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ words: ["ok", 42] }),
  });
  assert.equal(bad.status, 400);
  const payload = await jsonOf(bad);
  assert.equal(payload.error.code, "validation_error");

  const good = await fetch(`${url}/v1/dictionary`, {
    method: "PUT",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ words: ["one", "two"] }),
  });
  assert.equal(good.status, 200);
  assert.deepEqual((await jsonOf(good)).data, ["one", "two"]);
});

test("aliases can be added, overwrite by from, and removed", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const add = await fetch(`${url}/v1/dictionary/aliases`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ from: "foo", to: "updated" }),
  });
  assert.equal(add.status, 200);
  assert.deepEqual((await jsonOf(add)).data, [{ from: "foo", to: "updated" }]);

  const add2 = await fetch(`${url}/v1/dictionary/aliases`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ from: "baz", to: "qux" }),
  });
  assert.equal(add2.status, 200);
  assert.deepEqual((await jsonOf(add2)).data, [
    { from: "foo", to: "updated" },
    { from: "baz", to: "qux" },
  ]);

  const remove = await fetch(`${url}/v1/dictionary/aliases?from=${encodeURIComponent("foo")}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  assert.equal(remove.status, 200);
  const payload = await jsonOf(remove);
  assert.deepEqual(payload.data.removed, [{ from: "foo", to: "updated" }]);
  assert.deepEqual(payload.data.aliases, [{ from: "baz", to: "qux" }]);

  await new Promise((resolve) => setImmediate(resolve));
  const aliasBroadcast = ipc.state.broadcasts.find(
    (b) => b.channel === "dictionary-aliases-updated"
  );
  assert.ok(aliasBroadcast, "expected a dictionary-aliases-updated broadcast");
});

test("alias endpoints reject malformed bodies with 400", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const single = await fetch(`${url}/v1/dictionary/aliases`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ from: "", to: "x" }),
  });
  assert.equal(single.status, 400);

  const replace = await fetch(`${url}/v1/dictionary/aliases`, {
    method: "PUT",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ aliases: [{ from: "a" }] }),
  });
  assert.equal(replace.status, 400);

  const del = await fetch(`${url}/v1/dictionary/aliases`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  assert.equal(del.status, 400);
});

test("tags route lists tags", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/tags`, { headers: authHeaders(token) });
  assert.equal(response.status, 200);
  assert.deepEqual((await jsonOf(response)).data, ["alpha", "beta"]);
});

test("note creation forwards tags through saveNote", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/notes/create`, {
    method: "POST",
    headers: authHeaders(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ title: "T", content: "C", tags: ["x", "y"] }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(ipc.state.savedNoteArgs.tags, ["x", "y"]);
  assert.equal(ipc.state.savedNoteArgs.transcript, null);
});

test("requests without a bearer token are rejected", async (t) => {
  const ipc = createIpcHandlers();
  const { url } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/dictionary`);
  assert.equal(response.status, 401);
});

test("empty search query returns a validation error, not a server error", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/notes/search?q=`, { headers: authHeaders(token) });
  assert.equal(response.status, 400);
  const payload = await jsonOf(response);
  assert.equal(payload.error.code, "validation_error");
});
