"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  AgentAccessSettings,
  DEFAULT_TOOLSET,
  getAgentAccessFilePath,
  normalizeToolset,
} = require("../../src/helpers/agentAccess");

function createTempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "superting-agent-access-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a fresh install starts in lean mode", (t) => {
  const homeDir = createTempHome(t);
  const settings = new AgentAccessSettings({ homeDir });
  assert.equal(DEFAULT_TOOLSET, "lean");
  assert.equal(settings.getToolset(), "lean");
  assert.equal(settings.isLean(), true);
  assert.equal(
    getAgentAccessFilePath(homeDir),
    path.join(homeDir, ".superting", "agent-access.json")
  );
  assert.equal(fs.existsSync(settings.filePath), false);
});

test("the mode persists and notifies listeners exactly once per change", (t) => {
  const homeDir = createTempHome(t);
  const settings = new AgentAccessSettings({ homeDir });
  const seen = [];
  const unsubscribe = settings.onChange((toolset) => seen.push(toolset));

  settings.setToolset("extended");
  assert.equal(settings.getToolset(), "extended");
  assert.deepEqual(seen, ["extended"]);

  const stored = JSON.parse(fs.readFileSync(settings.filePath, "utf8"));
  assert.equal(stored.toolset, "extended");
  assert.equal(stored.version, 1);

  // A new instance (next app launch) reads the persisted value.
  assert.equal(new AgentAccessSettings({ homeDir }).getToolset(), "extended");

  // Setting the same value is a no-op, not a re-notification.
  settings.setToolset("extended");
  assert.deepEqual(seen, ["extended"]);

  settings.setToolset("lean");
  assert.deepEqual(seen, ["extended", "lean"]);

  unsubscribe();
  settings.setToolset("extended");
  assert.deepEqual(seen, ["extended", "lean"]);
});

test("invalid values are rejected and stored garbage falls back to lean", (t) => {
  const homeDir = createTempHome(t);
  const settings = new AgentAccessSettings({ homeDir });
  assert.throws(() => settings.setToolset("everything"), /Unknown agent toolset/);
  assert.throws(() => settings.setToolset(null), /Unknown agent toolset/);
  assert.equal(settings.getToolset(), "lean");

  assert.equal(normalizeToolset("lean"), "lean");
  assert.equal(normalizeToolset("extended"), "extended");
  assert.equal(normalizeToolset("full"), null);

  fs.mkdirSync(path.dirname(settings.filePath), { recursive: true });
  fs.writeFileSync(settings.filePath, JSON.stringify({ toolset: "full" }));
  assert.equal(new AgentAccessSettings({ homeDir }).getToolset(), "lean");

  fs.writeFileSync(settings.filePath, "{not json");
  assert.equal(new AgentAccessSettings({ homeDir }).getToolset(), "lean");
});
