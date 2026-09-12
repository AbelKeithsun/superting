const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const cliPath = path.resolve(__dirname, "..", "..", "cli", "superting.js");
const {
  parseArgv,
  matchCommand,
  buildCommandRegistry,
  loadBridgeConfig,
} = require("../../cli/superting");

// ---------------------------------------------------------------------------
// Unit: argument parsing and command matching
// ---------------------------------------------------------------------------

test("parseArgv separates globals, flags, and positionals", () => {
  const parsed = parseArgv(
    ["notes", "update", "3", "--find", "a b", "--replace=x", "--yes", "--format", "json"],
    { globalFlags: new Set(["format", "yes"]) }
  );
  assert.deepEqual(parsed.positional, ["notes", "update", "3"]);
  assert.equal(parsed.flags.get("find")[0], "a b");
  assert.equal(parsed.flags.get("replace")[0], "x");
  assert.equal(parsed.global.get("yes")[0], "true");
  assert.equal(parsed.global.get("format")[0], "json");
});

test("parseArgv stops flag parsing after --", () => {
  const parsed = parseArgv(["dict", "add", "--", "--literal", "word"], {
    globalFlags: new Set(),
  });
  assert.deepEqual(parsed.positional, ["dict", "add", "--literal", "word"]);
});

test("parseArgv rejects a flag without a value", () => {
  assert.throws(() => parseArgv(["notes", "create", "--title"], { globalFlags: new Set() }));
});

test("matchCommand prefers the two-word form", () => {
  const commands = buildCommandRegistry();
  const two = matchCommand(commands, ["notes", "list", "--limit", "5"]);
  assert.equal(two.spec.name, "notes list");
  assert.deepEqual(two.args, ["--limit", "5"]);
  const one = matchCommand(commands, ["health"]);
  assert.equal(one.spec.name, "health");
  assert.equal(matchCommand(commands, ["nope"]), null);
});

test("every registered command is documented in usage", () => {
  const commands = buildCommandRegistry();
  const usage = require("../../cli/superting").buildUsage(commands);
  for (const { name, usage: commandUsage } of commands.values()) {
    assert.ok(usage.includes(commandUsage), `usage missing ${name}`);
  }
});

test("loadBridgeConfig errors clearly when the bridge file is missing", () => {
  assert.throws(
    () => loadBridgeConfig(path.join(os.tmpdir(), "definitely-missing-bridge.json")),
    /bridge_not_running|Start the SuperTing app/i
  );
});

// ---------------------------------------------------------------------------
// Integration: CLI process against a mock bridge server
// ---------------------------------------------------------------------------

function startMockBridge(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        body: raw ? JSON.parse(raw) : null,
      });
      const respond = (status, payload) => {
        if (status === 204) {
          res.writeHead(204);
          res.end();
          return;
        }
        const body = JSON.stringify(payload);
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      };
      if (!req.headers.authorization) {
        respond(401, { error: { code: "unauthorized", message: "Unauthorized" } });
        return;
      }
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/health") {
        respond(200, { data: { ok: true, version: 1 } });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/dictionary/words") {
        respond(200, {
          data: { added: (JSON.parse(raw) || {}).words || [], dictionary: [] },
        });
        return;
      }
      if (req.method === "DELETE" && url.pathname === "/v1/notes/7") {
        respond(204);
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/notes/3") {
        respond(200, { data: { id: 3, content: "hello Fun ASR world" } });
        return;
      }
      if (req.method === "PATCH" && url.pathname === "/v1/notes/3") {
        respond(200, { data: { id: 3, ...(JSON.parse(raw) || {}) } });
        return;
      }
      respond(404, { error: { code: "not_found", message: "Not found" } });
    });
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "superting-cli-bin-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return new Promise((resolve) => {
    server.once("listening", () => {
      const bridgeFile = path.join(home, "cli-bridge.json");
      fs.writeFileSync(
        bridgeFile,
        JSON.stringify({ version: 1, port: server.address().port, token: "test-token" })
      );
      resolve({ server, bridgeFile, requests });
    });
  });
}

async function runCli(args, bridgeFile) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cliPath, ...args], {
      env: { ...process.env, SUPERTING_BRIDGE_FILE: bridgeFile },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || "", stderr: err.stderr || "" };
  }
}

test("health prints JSON and exits 0", async (t) => {
  const { bridgeFile } = await startMockBridge(t);
  const result = await runCli(["health"], bridgeFile);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { data: { ok: true, version: 1 } });
});

test("dict add sends the words array to the bridge", async (t) => {
  const { bridgeFile, requests } = await startMockBridge(t);
  const result = await runCli(["dict", "add", "超级听记", "SenseVoice"], bridgeFile);
  assert.equal(result.code, 0);
  const request = requests.find((r) => r.url === "/v1/dictionary/words");
  assert.ok(request);
  assert.deepEqual(request.body, { words: ["超级听记", "SenseVoice"] });
});

test("notes update --find/--replace patches replaced content", async (t) => {
  const { bridgeFile, requests } = await startMockBridge(t);
  const result = await runCli(
    ["notes", "update", "3", "--find", "Fun ASR", "--replace", "FunASR"],
    bridgeFile
  );
  assert.equal(result.code, 0);
  const patch = requests.find((r) => r.method === "PATCH");
  assert.deepEqual(patch.body, { content: "hello FunASR world" });
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.data.content, "hello FunASR world");
});

test("notes delete refuses without --yes and succeeds with it", async (t) => {
  const { bridgeFile, requests } = await startMockBridge(t);

  const refused = await runCli(["notes", "delete", "7"], bridgeFile);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /--yes/);
  assert.equal(requests.length, 0);

  const confirmed = await runCli(["notes", "delete", "7", "--yes"], bridgeFile);
  assert.equal(confirmed.code, 0);
  assert.deepEqual(JSON.parse(confirmed.stdout), { data: { id: 7, deleted: true } });
  assert.ok(requests.some((r) => r.method === "DELETE" && r.url === "/v1/notes/7"));
});

test("unknown command exits 2 with usage on stderr", async (t) => {
  const { bridgeFile } = await startMockBridge(t);
  const result = await runCli(["notes", "explode"], bridgeFile);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /Unknown command/);
});

test("missing bridge file exits 1 with a structured error", async () => {
  const missing = path.join(os.tmpdir(), "superting-no-such-bridge.json");
  const result = await runCli(["health"], missing);
  assert.equal(result.code, 1);
  const payload = JSON.parse(result.stderr);
  assert.equal(payload.error.code, "bridge_not_running");
});

test("text format renders key/value lines", async (t) => {
  const { bridgeFile } = await startMockBridge(t);
  const result = await runCli(["health", "--format", "text"], bridgeFile);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /ok: true/);
});
