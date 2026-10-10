const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const CliBridge = require("../../src/helpers/cliBridge");

/**
 * End-to-end proof that the CLI bridge is a projection of the operation
 * registry: the catalog route lists every capability, IPC-backed capabilities
 * go through the app's own handler channels, and UI-bound ones answer 503
 * `renderer_unavailable` instead of pretending to work.
 */

function createTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superting-clip-ops-"));
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

const ACTION = {
  id: 1,
  name: "生成会议纪要",
  description: "Turn meeting transcripts into structured meeting minutes",
  prompt: "…",
  output_target: "content",
  write_mode: "overwrite",
};

function createIpcHandlers() {
  const calls = [];
  return {
    calls,
    databaseManager: {
      getAction: (id) => (id === 1 ? ACTION : null),
      getActions: () => [ACTION],
      getFolders: () => [],
      getTags: () => [],
      getDictionary: () => [],
      getDictionaryAliases: () => [],
      listDictionaryGroups: () => [],
      listDictionaryGroupAssignments: () => () => ({}),
      getTranscriptions: () => [],
    },
    broadcastToWindows: () => {},
    invokeChannel: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel === "people-list") {
        return { success: true, people: [{ id: 7, display_name: "Anna" }] };
      }
      return { success: true };
    },
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
  return { url: `http://127.0.0.1:${bridge.port}`, token: bridge.token };
}

const auth = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const jsonOf = async (response) => {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
};

test("the bridge publishes the capability catalog", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/operations`, { headers: auth(token) });
  assert.equal(response.status, 200);
  const payload = await jsonOf(response);
  assert.ok(Array.isArray(payload.data));
  assert.ok(payload.data.length >= 70, `expected the full registry, got ${payload.data.length}`);

  const byId = new Map(payload.data.map((operation) => [operation.id, operation]));
  const actionRun = byId.get("actions.run");
  assert.equal(actionRun.rendererRequired, true);
  assert.equal(actionRun.cli.method, "POST");
  assert.equal(actionRun.cli.path, "/v1/actions/:id/run");
  assert.deepEqual(Object.keys(actionRun.cli.params).sort(), ["id", "note_id"]);
  assert.equal(byId.get("people.list").cli.params.query, "query");
  assert.equal(byId.get("settings.set").policy, "write");
});

test("IPC-backed routes call the app's own handler channels", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/people?query=anna`, { headers: auth(token) });
  assert.equal(response.status, 200);
  assert.deepEqual(await jsonOf(response), { data: [{ id: 7, display_name: "Anna" }] });
  assert.deepEqual(ipc.calls.at(-1), ["people-list", "anna"]);

  const compress = await fetch(`${url}/v1/notes/4/audio/compress`, {
    method: "POST",
    headers: auth(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ audio_file_id: 9 }),
  });
  assert.equal(compress.status, 200);
  assert.deepEqual(ipc.calls.at(-1), ["compress-note-audio", 4, 9]);
});

test("UI-bound routes answer 503 renderer_unavailable without a window", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const run = await fetch(`${url}/v1/actions/1/run`, {
    method: "POST",
    headers: auth(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ note_id: 2 }),
  });
  assert.equal(run.status, 503);
  const payload = await jsonOf(run);
  assert.equal(payload.error.code, "renderer_unavailable");
  assert.match(payload.error.message, /window/i);

  const settings = await fetch(`${url}/v1/settings`, { headers: auth(token) });
  assert.equal(settings.status, 503);

  // The action itself is never dispatched when the UI is unavailable.
  assert.equal(
    ipc.calls.some(([channel]) => channel === "run_note_action"),
    false
  );
});

test("destructive routes validate required parameters before running", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const missing = await fetch(`${url}/v1/people/merge`, {
    method: "POST",
    headers: auth(token, { "Content-Type": "application/json" }),
    body: JSON.stringify({ keep_id: 1 }),
  });
  assert.equal(missing.status, 400);
  const payload = await jsonOf(missing);
  assert.equal(payload.error.code, "validation_error");
  assert.match(payload.error.message, /remove_id/);
});

test("the CLI's own command still resolves through the registry", async (t) => {
  const ipc = createIpcHandlers();
  const { url, token } = await startBridge(t, ipc);

  const response = await fetch(`${url}/v1/actions`, { headers: auth(token) });
  assert.equal(response.status, 200);
  const payload = await jsonOf(response);
  assert.equal(payload.data[0].name, "生成会议纪要");
});
