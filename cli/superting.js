#!/usr/bin/env node
// SuperTing Agent CLI — dws-style local client for a running SuperTing desktop app.
//
// Talks to the app's loopback CLI bridge (see src/helpers/cliBridge.js):
//   - bridge metadata (port + bearer token) lives at ~/.superting/cli-bridge.json
//   - every command is a single fast loopback HTTP call, no session handshake
//
// Design rules (mirror the DingTalk dws client pattern):
//   - every command prints machine-parseable JSON (default; --format text for humans)
//   - IDs must come from command output, never be guessed
//   - destructive commands (delete / full replace) require an explicit --yes

"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CLI_NAME = "superting";
const DEFAULT_BRIDGE_FILE = path.join(os.homedir(), ".superting", "cli-bridge.json");
const LIST_CONTENT_PREVIEW_CHARS = 500;

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;


class ArgError extends Error {}

/**
 * Parses argv into { global: Map<string, string[]>, flags: Map<string, string[]>, positional: string[] }.
 * Supports "--key value", "--key=value", and boolean flags. "--" stops flag parsing.
 */
function parseArgv(argv, { globalFlags = new Set() } = {}) {
  const global = new Map();
  const flags = new Map();
  const positional = [];
  const booleanFlags = new Set(["yes", "full", "help", "version"]);

  const push = (store, key, value) => {
    if (!store.has(key)) store.set(key, []);
    store.get(key).push(value);
  };

  let i = 0;
  let positionalOnly = false;
  while (i < argv.length) {
    const token = argv[i];
    if (positionalOnly) {
      positional.push(token);
      i += 1;
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      let key;
      let value;
      let inline = false;
      if (eq !== -1) {
        key = token.slice(2, eq);
        value = token.slice(eq + 1);
        inline = true;
      } else {
        key = token.slice(2);
      }
      if (!key) throw new ArgError(`Invalid flag "${token}"`);
      if (booleanFlags.has(key)) {
        value = "true";
        inline = true;
      }
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new ArgError(`Flag --${key} expects a value`);
        value = argv[i + 1];
        if (value.startsWith("--") && !booleanFlags.has(key)) {
          throw new ArgError(`Flag --${key} expects a value, got "${value}"`);
        }
        i += 1;
      }
      push(globalFlags.has(key) ? global : flags, key, value);
      i += 1;
      continue;
    }
    positional.push(token);
    i += 1;
  }
  return { global, flags, positional };
}

function last(map, key) {
  const values = map.get(key);
  return values ? values[values.length - 1] : undefined;
}

function all(map, key) {
  return map.get(key) || [];
}

function intFlag(flags, key, fallback) {
  const raw = last(flags, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgError(`--${key} expects a positive integer, got "${raw}"`);
  }
  return value;
}

function intPositional(raw, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ArgError(`${label} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function parseTagList(raw) {
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}


class BridgeError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function resolveBridgePath(cliFlags) {
  const explicit = last(cliFlags, "bridge") || process.env.SUPERTING_BRIDGE_FILE;
  return explicit || DEFAULT_BRIDGE_FILE;
}

function loadBridgeConfig(bridgePath) {
  let raw;
  try {
    raw = fs.readFileSync(bridgePath, "utf8");
  } catch (err) {
    throw new BridgeError(
      `SuperTing desktop app bridge not found at ${bridgePath}. ` +
        "Start the SuperTing app first (it writes the bridge file on launch), " +
        "or pass --bridge <path> / set SUPERTING_BRIDGE_FILE.",
      { code: "bridge_not_running" }
    );
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw new BridgeError(`Bridge file ${bridgePath} is not valid JSON`, {
      code: "bridge_invalid",
    });
  }
  if (!config.port || !config.token) {
    throw new BridgeError(`Bridge file ${bridgePath} is missing port/token`, {
      code: "bridge_invalid",
    });
  }
  return config;
}

async function bridgeRequest(bridge, method, route, { query, body } = {}) {
  let url = `http://127.0.0.1:${bridge.port}${route}`;
  if (query && Object.keys(query).length > 0) {
    const search = new URLSearchParams();
    for (const [key, values] of Object.entries(query)) {
      for (const value of [].concat(values)) {
        if (value !== undefined && value !== null) search.append(key, String(value));
      }
    }
    url += `?${search.toString()}`;
  }
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bridge.token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new BridgeError(`Bridge request timed out: ${method} ${route}`, {
        code: "bridge_timeout",
      });
    }
    throw new BridgeError(
      `Cannot reach the SuperTing desktop app bridge at 127.0.0.1:${bridge.port} ` +
        `(${err.message}). Is the app running?`,
      { code: "bridge_not_running" }
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.error || `HTTP ${response.status}`;
    throw new BridgeError(message, { status: response.status, code: payload?.error?.code });
  }
  return payload;
}


function truncatePreview(text, limit) {
  if (typeof text !== "string" || text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function withNotePreviews(payload, { full }) {
  if (full || !Array.isArray(payload?.data)) return payload;
  payload.data = payload.data.map((note) => {
    if (!note || typeof note !== "object") return note;
    const clone = { ...note };
    if (typeof clone.content === "string") {
      clone.content = truncatePreview(clone.content, LIST_CONTENT_PREVIEW_CHARS);
    }
    if (typeof clone.enhanced_content === "string" && clone.enhanced_content) {
      clone.enhanced_content = truncatePreview(clone.enhanced_content, LIST_CONTENT_PREVIEW_CHARS);
    }
    return clone;
  });
  return payload;
}

function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function printText(payload) {
  if (payload === null || payload === undefined) return;
  const render = (value, indent) => {
    if (Array.isArray(value)) {
      for (const item of value) render(item, indent);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (item && typeof item === "object") {
          process.stdout.write(`${" ".repeat(indent)}${key}:\n`);
          render(item, indent + 2);
        } else {
          process.stdout.write(`${" ".repeat(indent)}${key}: ${String(item)}\n`);
        }
      }
      if (Array.isArray(value) && value.length === 0) return;
      return;
    }
    process.stdout.write(`${" ".repeat(indent)}${value}\n`);
  };
  render(payload, 0);
}


function requireYes(cliFlags, action) {
  if (last(cliFlags, "yes") !== "true") {
    throw new ArgError(
      `${action} is destructive. Re-run with --yes to confirm (or ask the user first).`
    );
  }
}

function buildCommandRegistry() {
  const commands = new Map();

  const command = (name, { description, usage, destructive = false, run }) => {
    commands.set(name, { name, description, usage, destructive, run });
  };

  command("health", {
    description: "Check whether the SuperTing desktop app bridge is reachable.",
    usage: "superting health",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/health"),
  });

  command("notes list", {
    description: "List notes (content truncated to 500 chars unless --full).",
    usage:
      "superting notes list [--limit N] [--type personal|meeting|...] [--folder-id ID] [--full]",
    run: async ({ bridge, flags }) => {
      const query = {};
      const limit = intFlag(flags, "limit", 100);
      if (limit !== 100) query.limit = limit;
      if (flags.has("type")) query.note_type = last(flags, "type");
      if (flags.has("folder-id")) query.folder_id = intFlag(flags, "folder-id", 0);
      const payload = await bridgeRequest(bridge, "GET", "/v1/notes/list", { query });
      return withNotePreviews(payload, { full: last(flags, "full") === "true" });
    },
  });

  command("notes get", {
    description: "Get one note with full text fields (content, enhanced content, transcript).",
    usage: "superting notes get <id>",
    run: async ({ bridge, positional }) => {
      const id = intPositional(positional[0], "Note id");
      return bridgeRequest(bridge, "GET", `/v1/notes/${id}`);
    },
  });

  command("notes search", {
    description: "Full-text keyword search over notes.",
    usage: "superting notes search <query> [--limit N] [--full]",
    run: async ({ bridge, flags, positional }) => {
      const query = positional.join(" ");
      if (!query.trim()) throw new ArgError("Search query is required");
      const search = { q: query };
      const limit = intFlag(flags, "limit", 20);
      if (limit !== 20) search.limit = limit;
      const payload = await bridgeRequest(bridge, "GET", "/v1/notes/search", { query: search });
      return withNotePreviews(payload, { full: last(flags, "full") === "true" });
    },
  });

  command("notes create", {
    description: "Create a note. Prints the created note (extract the id from here).",
    usage:
      "superting notes create --title <title> [--content <text>] [--type personal] [--folder-id ID] [--tags a,b]",
    run: async ({ bridge, flags }) => {
      const title = last(flags, "title");
      if (!title) throw new ArgError("--title is required");
      const body = { title, content: last(flags, "content") ?? "" };
      if (flags.has("type")) body.note_type = last(flags, "type");
      if (flags.has("folder-id")) body.folder_id = intFlag(flags, "folder-id", 0);
      const tags = parseTagList(last(flags, "tags"));
      if (tags) body.tags = tags;
      return bridgeRequest(bridge, "POST", "/v1/notes/create", { body });
    },
  });

  command("notes update", {
    description:
      "Edit a note. Supports --find/--replace (literal, all occurrences) applied to content.",
    usage:
      "superting notes update <id> [--title <t>] [--content <c>] [--transcript <t>] " +
      "[--folder-id ID] [--tags a,b] [--find <text> --replace <text>]",
    run: async ({ bridge, flags, positional }) => {
      const id = intPositional(positional[0], "Note id");
      const body = {};
      if (flags.has("title")) body.title = last(flags, "title");
      if (flags.has("content")) body.content = last(flags, "content");
      if (flags.has("transcript")) body.transcript = last(flags, "transcript");
      if (flags.has("folder-id")) body.folder_id = intFlag(flags, "folder-id", 0);
      const tags = parseTagList(last(flags, "tags"));
      if (tags) body.tags = tags;
      const find = last(flags, "find");
      const replace = last(flags, "replace");
      if (find !== undefined) {
        if (replace === undefined) throw new ArgError("--find requires --replace");
        const current = await bridgeRequest(bridge, "GET", `/v1/notes/${id}`);
        const content = current?.data?.content ?? "";
        body.content = content.split(find).join(replace);
      } else if (replace !== undefined) {
        throw new ArgError("--replace requires --find");
      }
      if (Object.keys(body).length === 0) {
        throw new ArgError("Provide at least one of --title/--content/--transcript/--folder-id/--tags/--find");
      }
      return bridgeRequest(bridge, "PATCH", `/v1/notes/${id}`, { body });
    },
  });

  command("notes append", {
    description: "Append text to the end of a note's content (adds a newline separator).",
    usage: "superting notes append <id> --text <text>",
    run: async ({ bridge, flags, positional }) => {
      const id = intPositional(positional[0], "Note id");
      const text = last(flags, "text");
      if (text === undefined) throw new ArgError("--text is required");
      const current = await bridgeRequest(bridge, "GET", `/v1/notes/${id}`);
      const existing = current?.data?.content ?? "";
      const next = existing ? `${existing}\n${text}` : text;
      return bridgeRequest(bridge, "PATCH", `/v1/notes/${id}`, { body: { content: next } });
    },
  });

  command("notes delete", {
    description: "Delete a note (moves to trash semantics of the app; destructive).",
    usage: "superting notes delete <id> --yes",
    destructive: true,
    run: async ({ bridge, positional, cliFlags }) => {
      const id = intPositional(positional[0], "Note id");
      requireYes(cliFlags, `Deleting note ${id}`);
      await bridgeRequest(bridge, "DELETE", `/v1/notes/${id}`);
      return { data: { id, deleted: true } };
    },
  });

  command("folders list", {
    description: "List folders.",
    usage: "superting folders list",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/folders/list"),
  });

  command("folders create", {
    description: "Create a folder. Prints the created folder (extract the id from here).",
    usage: "superting folders create --name <name>",
    run: async ({ bridge, flags }) => {
      const name = last(flags, "name");
      if (!name) throw new ArgError("--name is required");
      return bridgeRequest(bridge, "POST", "/v1/folders/create", { body: { name } });
    },
  });

  command("transcriptions list", {
    description: "List dictation transcriptions (text + audio metadata only).",
    usage: "superting transcriptions list [--limit N]",
    run: async ({ bridge, flags }) => {
      const query = {};
      const limit = intFlag(flags, "limit", 50);
      if (limit !== 50) query.limit = limit;
      return bridgeRequest(bridge, "GET", "/v1/transcriptions/list", { query });
    },
  });

  command("transcriptions get", {
    description: "Get one transcription record.",
    usage: "superting transcriptions get <id>",
    run: async ({ bridge, positional }) => {
      const id = intPositional(positional[0], "Transcription id");
      return bridgeRequest(bridge, "GET", `/v1/transcriptions/${id}`);
    },
  });

  command("tags list", {
    description: "List tags used across notes.",
    usage: "superting tags list",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/tags"),
  });

  command("dict list", {
    description: "List custom dictionary hotwords (passed to the ASR as hints).",
    usage: "superting dict list",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/dictionary"),
  });

  command("dict add", {
    description: "Add one or more hotwords (case-insensitive dedupe).",
    usage: "superting dict add <word> [word...]",
    run: async ({ bridge, positional }) => {
      const words = positional.filter(Boolean);
      if (words.length === 0) throw new ArgError("Provide at least one word to add");
      return bridgeRequest(bridge, "POST", "/v1/dictionary/words", { body: { words } });
    },
  });

  command("dict remove", {
    description: "Remove hotwords (destructive).",
    usage: "superting dict remove <word> [word...] --yes",
    destructive: true,
    run: async ({ bridge, positional, cliFlags }) => {
      const words = positional.filter(Boolean);
      if (words.length === 0) throw new ArgError("Provide at least one word to remove");
      requireYes(cliFlags, `Removing dictionary word(s): ${words.join(", ")}`);
      return bridgeRequest(bridge, "DELETE", "/v1/dictionary/words", { query: { word: words } });
    },
  });

  command("dict replace", {
    description: "Replace the entire dictionary (destructive).",
    usage: "superting dict replace --words a,b,c --yes  |  superting dict replace --json '[\"a\",\"b\"]' --yes",
    destructive: true,
    run: async ({ bridge, flags, positional, cliFlags }) => {
      let words;
      if (flags.has("json")) {
        try {
          words = JSON.parse(last(flags, "json"));
        } catch {
          throw new ArgError("--json must be a valid JSON array of strings");
        }
      } else if (flags.has("words")) {
        words = parseTagList(last(flags, "words"));
      } else {
        words = positional.filter(Boolean);
      }
      if (!Array.isArray(words) || words.length === 0) {
        throw new ArgError("Provide the full word list via --words a,b,c or --json '[...]'");
      }
      requireYes(cliFlags, "Replacing the entire dictionary");
      return bridgeRequest(bridge, "PUT", "/v1/dictionary", { body: { words } });
    },
  });

  command("alias list", {
    description: "List hotword replacement rules ({from, to} applied after transcription).",
    usage: "superting alias list",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/dictionary/aliases"),
  });

  command("alias add", {
    description: "Add or update one replacement rule (existing rule with same from is overwritten).",
    usage: "superting alias add <from> <to>",
    run: async ({ bridge, positional, flags }) => {
      let from = positional[0];
      let to = positional[1];
      if (flags.has("from")) from = last(flags, "from");
      if (flags.has("to")) to = last(flags, "to");
      if (!from || !to) throw new ArgError("Usage: superting alias add <from> <to>");
      return bridgeRequest(bridge, "POST", "/v1/dictionary/aliases", { body: { from, to } });
    },
  });

  command("alias remove", {
    description: "Remove replacement rules by their from text (destructive).",
    usage: "superting alias remove <from> [from...] --yes",
    destructive: true,
    run: async ({ bridge, positional, cliFlags }) => {
      const froms = positional.filter(Boolean);
      if (froms.length === 0) throw new ArgError("Provide at least one from text to remove");
      requireYes(cliFlags, `Removing alias rule(s): ${froms.join(", ")}`);
      return bridgeRequest(bridge, "DELETE", "/v1/dictionary/aliases", { query: { from: froms } });
    },
  });

  command("alias replace", {
    description: "Replace all replacement rules (destructive).",
    usage: `superting alias replace --json '[{"from":"a","to":"b"}]' --yes`,
    destructive: true,
    run: async ({ bridge, flags, cliFlags }) => {
      if (!flags.has("json")) {
        throw new ArgError('--json is required, e.g. --json \'[{"from":"a","to":"b"}]\'');
      }
      let aliases;
      try {
        aliases = JSON.parse(last(flags, "json"));
      } catch {
        throw new ArgError("--json must be a valid JSON array of {from, to} objects");
      }
      if (!Array.isArray(aliases)) {
        throw new ArgError("--json must be a JSON array of {from, to} objects");
      }
      requireYes(cliFlags, "Replacing all alias rules");
      return bridgeRequest(bridge, "PUT", "/v1/dictionary/aliases", { body: { aliases } });
    },
  });

  return commands;
}


function buildUsage(commands) {
  const lines = [
    `${CLI_NAME} <command> [args] [--format json|text] [--bridge <path>] [--yes]`,
    "",
    "Local client for a running SuperTing desktop app (loopback bridge, no MCP).",
    "Default output is JSON. Destructive commands require --yes.",
    "",
    "Commands:",
  ];
  for (const { name, usage, description } of commands.values()) {
    lines.push(`  ${usage}`);
    lines.push(`      ${description}`);
  }
  lines.push("");
  lines.push("Flags:");
  lines.push("  --format json|text   Output format (default json)");
  lines.push("  --bridge <path>      Bridge metadata file (default ~/.superting/cli-bridge.json)");
  lines.push("  --yes                Confirm destructive operations");
  lines.push("  --full               notes list/search: do not truncate content previews");
  lines.push("  --help / --version");
  return lines.join("\n");
}

function matchCommand(commands, positional) {
  if (positional.length === 0) return null;
  const twoPart = `${positional[0]} ${positional[1]}`;
  if (commands.has(twoPart)) {
    return { spec: commands.get(twoPart), args: positional.slice(2) };
  }
  if (commands.has(positional[0])) {
    return { spec: commands.get(positional[0]), args: positional.slice(1) };
  }
  return null;
}

async function runCli(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  const commands = buildCommandRegistry();
  const globalFlagNames = new Set(["format", "bridge", "yes", "help", "version"]);

  let parsed;
  try {
    parsed = parseArgv(argv, { globalFlags: globalFlagNames });
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return EXIT_USAGE;
  }

  if (last(parsed.global, "version") === "true") {
    const { version } = require("../package.json");
    stdout.write(`${version}\n`);
    return EXIT_OK;
  }
  if (last(parsed.global, "help") === "true" || parsed.positional.length === 0) {
    stdout.write(`${buildUsage(commands)}\n`);
    return EXIT_OK;
  }

  const match = matchCommand(commands, parsed.positional);
  if (!match) {
    stderr.write(
      `Unknown command: ${parsed.positional.join(" ")}\n\n${buildUsage(commands)}\n`
    );
    return EXIT_USAGE;
  }

  const format = last(parsed.global, "format") || "json";
  if (format !== "json" && format !== "text") {
    stderr.write(`--format must be "json" or "text", got "${format}"\n`);
    return EXIT_USAGE;
  }

  try {
    const bridge = loadBridgeConfig(resolveBridgePath(parsed.global));
    const payload = await match.spec.run({
      bridge,
      flags: parsed.flags,
      cliFlags: parsed.global,
      positional: match.args,
    });
    if (format === "json") printJson(payload);
    else printText(payload);
    return EXIT_OK;
  } catch (err) {
    if (err instanceof ArgError) {
      stderr.write(`${err.message}\n`);
      return EXIT_USAGE;
    }
    const detail = {
      error: {
        code: err.code || "cli_error",
        message: err.message,
        ...(err.status ? { status: err.status } : {}),
      },
    };
    stderr.write(`${JSON.stringify(detail, null, 2)}\n`);
    return EXIT_ERROR;
  }
}

module.exports = {
  parseArgv,
  buildCommandRegistry,
  matchCommand,
  resolveBridgePath,
  loadBridgeConfig,
  buildUsage,
  CLI_NAME,
  DEFAULT_BRIDGE_FILE,
};

if (require.main === module) {
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) {
    process.stderr.write(`${CLI_NAME} requires Node.js >= 18 (found ${process.versions.node})\n`);
    process.exit(EXIT_USAGE);
  }
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
