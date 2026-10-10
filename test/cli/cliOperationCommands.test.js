const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildCommandRegistry, matchCommand, parseArgv } = require("../../cli/superting");
const app = require("../../src/helpers/appOperations/index.js");

/**
 * The agent skill (and README) promise ergonomic commands for every capability
 * family. These tests keep the three views — the operation registry, the CLI
 * command table and the shipped docs — from drifting apart again: a command that
 * names an operation the app no longer exposes, or a documented command that the
 * CLI does not implement, both fail here.
 */

const ROOT = path.join(__dirname, "..", "..");

function operationIds() {
  return new Set(app.listMcpTools().map((tool) => tool.name)); // names ≠ ids; use registry below
}

function registryOperationIds() {
  // createAppOperations needs an IPC handler stub; invokeChannel is only used at
  // call time, so an empty object is enough to read the catalog.
  const { createAppOperations } = require("../../src/helpers/appOperations/index.js");
  const registry = createAppOperations({
    databaseManager: {},
    broadcastToWindows() {},
  });
  return new Set(registry.operations.map((operation) => operation.id));
}

test("every command is reachable, including the multi-word ones", () => {
  const commands = buildCommandRegistry();
  assert.ok(commands.size >= 80, `expected the full command set, got ${commands.size}`);

  for (const name of commands.keys()) {
    const match = matchCommand(commands, name.split(" "));
    assert.ok(match, `unreachable command: ${name}`);
    assert.equal(match.spec.name, name);
  }

  // Longest match wins, so `dict groups list` is not swallowed by `dict`.
  const commandsMap = buildCommandRegistry();
  assert.equal(matchCommand(commandsMap, ["dict", "groups", "list"]).spec.name, "dict groups list");
  assert.equal(matchCommand(commandsMap, ["dict", "list"]).spec.name, "dict list");
  assert.equal(matchCommand(commandsMap, ["notes", "audio", "list"]).spec.name, "notes audio list");
  assert.equal(matchCommand(commandsMap, ["notes", "list"]).spec.name, "notes list");
});

test("every operation-backed command names a real operation id", () => {
  const source = fs.readFileSync(path.join(ROOT, "cli", "superting.js"), "utf8");
  const block = source.slice(
    source.indexOf("const OPERATION_COMMANDS = ["),
    source.indexOf("function buildCommandRegistry()")
  );
  assert.ok(block.length > 1000, "OPERATION_COMMANDS table not found");

  const rows = [...block.matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,/g)].map((match) => ({
    command: match[1],
    operation: match[2],
  }));
  assert.ok(rows.length >= 60, `expected ≥60 operation commands, got ${rows.length}`);

  const ids = registryOperationIds();
  const unknown = rows.filter((row) => !ids.has(row.operation));
  assert.deepEqual(
    unknown.map((row) => `${row.command} -> ${row.operation}`),
    [],
    "these commands point at operations the app does not expose"
  );

  const commands = buildCommandRegistry();
  for (const row of rows) {
    assert.ok(commands.has(row.command), `${row.command} is not registered`);
  }
});

test("snake_case params can be passed with hyphens, the way the docs write them", () => {
  const parsed = parseArgv(
    ["speakers", "assign", "--note-id", "47", "--speaker-id", "you", "--display-name", "Anna"],
    { globalFlags: new Set(["format", "yes"]) }
  );
  assert.equal(parsed.flags.get("note-id")[0], "47");

  const commands = buildCommandRegistry();
  const match = matchCommand(commands, parsed.positional);
  assert.equal(match.spec.name, "speakers assign");
});

test("the bundled skills only document commands that exist", () => {
  const commands = buildCommandRegistry();
  const docs = [
    path.join(ROOT, "agent-skills", "superting-cli", "SKILL.md"),
    path.join(ROOT, "agent-skills", "superting-cli", "references", "notes.md"),
    path.join(ROOT, "agent-skills", "superting-cli", "references", "dictionary.md"),
    path.join(ROOT, "agent-skills", "superting-cli", "references", "troubleshooting.md"),
  ];

  const problems = [];
  for (const file of docs) {
    const text = fs.readFileSync(file, "utf8");
    // `superting <word> [<word>] [<word>]` at the start of an example; flags and
    // placeholders (`--limit`, `<id>`) do not match, so they end the command name.
    for (const match of text.matchAll(
      /superting ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?(?: ([a-z][a-z-]*))?/g
    )) {
      const words = [match[1], match[2], match[3]].filter(Boolean);
      if (words[0] === "call") continue; // takes an operation id
      // Prefix matching on purpose: examples append placeholders (job-…, <id>)
      // that must not be read as part of the command name.
      if (!matchCommand(commands, words)) {
        problems.push(`${path.relative(ROOT, file)}: superting ${words.join(" ")}`);
      }
    }
  }
  assert.deepEqual([...new Set(problems)], [], "documented commands the CLI does not implement");
});

test("every registered command is documented in the CLI skill", () => {
  const commands = buildCommandRegistry();
  const skill = fs.readFileSync(
    path.join(ROOT, "agent-skills", "superting-cli", "SKILL.md"),
    "utf8"
  );
  const missing = [...commands.keys()].filter((name) => {
    const [first, second] = name.split(" ");
    return !(skill.includes(name) || (second && skill.includes(second)));
  });
  // The two discovery commands are documented via the cheat sheet's wording.
  const undoc = missing.filter((name) => name !== "call" && name !== "ops list");
  assert.deepEqual(undoc, [], "commands missing from the skill cheat sheet");
});
