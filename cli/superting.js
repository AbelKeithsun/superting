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

/**
 * Load one operation from the app's capability catalog. Placement of every
 * parameter (path/query/body) and destructiveness come from that catalog, so the
 * ergonomic commands below never hard-code routes or guess argument shapes.
 */
async function loadOperation(bridge, operationId) {
  const catalog = await bridgeRequest(bridge, "GET", "/v1/operations");
  const operation = (catalog?.data ?? []).find((item) => item.id === operationId);
  if (!operation) {
    throw new ArgError(
      `Operation "${operationId}" is not available in this app version (see: superting ops list)`
    );
  }
  return operation;
}

/** Read `--flag` values, accepting the hyphenated spelling of snake_case params. */
function flagValues(flags, name) {
  const direct = flags.get(name);
  if (direct && direct.length > 0) return direct;
  const hyphenated = name.replace(/_/g, "-");
  if (hyphenated !== name) return flags.get(hyphenated);
  return undefined;
}

/** Collect the operation's declared params from `--flag value` pairs. */
function paramsFromFlags(operation, flags, extra = {}) {
  const params = { ...extra };
  for (const [name, spec] of Object.entries(operation.params ?? {})) {
    const values = flagValues(flags, name);
    if (!values || values.length === 0) continue;
    if (spec.type === "array") {
      params[name] =
        values.length > 1
          ? values
          : String(values[0])
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean);
    } else {
      params[name] = values[values.length - 1];
    }
  }
  return params;
}

/** Execute one operation, honouring the app's own route/parameter placement. */
async function runOperationRequest(bridge, operation, { params = {}, cliFlags = new Map() } = {}) {
  if (operation.policy === "destructive") {
    requireYes(cliFlags, `Running ${operation.id}`);
  }

  const locations = operation.cli?.params ?? {};
  let route = operation.cli?.path ?? "";
  const query = {};
  const body = {};
  for (const [name, value] of Object.entries(params)) {
    const location = locations[name];
    if (location === "path") {
      route = route.replace(`:${name}`, encodeURIComponent(String(value)));
    } else if (location === "query") {
      query[name] = value;
    } else {
      body[name] = value;
    }
  }
  const missing = [...route.matchAll(/:([a-z0-9_]+)/g)].map((match) => match[1]);
  if (missing.length > 0) {
    throw new ArgError(`Missing required parameter(s): ${missing.join(", ")}`);
  }

  const method = operation.cli?.method ?? "GET";
  const hasBody = method !== "GET" && method !== "DELETE";
  return bridgeRequest(bridge, method, route, { query, body: hasBody ? body : undefined });
}

/**
 * Ergonomic commands for the capability families added after 2.0.4. Each row is
 * a thin wrapper over runOperationRequest; `superting call <operation.id>`
 * remains the escape hatch for anything not listed (and a test asserts every row
 * here maps to a real operation).
 */
const OPERATION_COMMANDS = [
  // notes: lifecycle, import/export, audio
  [
    "notes purge",
    "notes.purge",
    "Permanently delete a trashed note (irreversible).",
    "superting notes purge <id>",
  ],
  [
    "notes import",
    "notes.import",
    "Import a local txt/md/docx into a note.",
    "superting notes import <id> --file-path <f> [--target note|transcript]",
  ],
  [
    "notes export",
    "notes.export",
    "Render a note to md/txt/json text (no file written).",
    "superting notes export <id> [--format md|txt|json]",
  ],
  [
    "notes export-to-disk",
    "notes.export_files",
    "Export notes to a folder chosen in the app.",
    "superting notes export-to-disk --note-ids 1,2 --format md",
  ],
  [
    "notes audio list",
    "notes.audio.list",
    "List a note's retained audio files.",
    "superting notes audio list --id <n>",
  ],
  [
    "notes audio compress",
    "notes.audio.compress",
    "Compress a note's audio to Opus-in-WebM.",
    "superting notes audio compress --id <n> [--audio-file-id N]",
  ],
  [
    "notes audio merge",
    "notes.audio.merge",
    "Merge a note's audio segments into one file.",
    "superting notes audio merge --id <n>",
  ],
  [
    "notes audio rediarize",
    "notes.audio.rediarize",
    "Re-run speaker diarization for a note.",
    "superting notes audio rediarize --id <n>",
  ],
  // transcript segments
  [
    "transcript segments",
    "notes.transcript.segments",
    "List transcript segments (paged).",
    "superting transcript segments --id <n> [--offset N] [--limit N]",
  ],
  [
    "transcript segment-update",
    "notes.transcript.segment.update",
    "Edit one transcript segment's text or speaker.",
    'superting transcript segment-update --id <n> --json \'{"index":0,"text":"…"}\'',
  ],
  [
    "transcript segment-delete",
    "notes.transcript.segment.delete",
    "Delete transcript segments by id or index.",
    "superting transcript segment-delete --id <n> --index N [--count N]",
  ],
  // note actions
  ["actions list", "actions.list", "List note actions (built-in and custom)."],
  ["actions get", "actions.get", "Get one note action definition.", "superting actions get <id>"],
  ["actions create", "actions.create", "Create a custom note action."],
  [
    "actions update",
    "actions.update",
    "Update a note action.",
    "superting actions update <id> [--name …] [--prompt …]",
  ],
  ["actions delete", "actions.delete", "Delete a note action.", "superting actions delete <id>"],
  [
    "actions run",
    "actions.run",
    "Run a note action (e.g. 生成会议纪要) on a note.",
    "superting actions run <id> --note-id <n>",
  ],
  // jobs
  ["jobs list", "jobs.list", "List long-running operation jobs."],
  [
    "jobs get",
    "jobs.get",
    "Get one job's status, progress and result.",
    "superting jobs get <job_id>",
  ],
  [
    "jobs cancel",
    "jobs.cancel",
    "Request cancellation of a running job.",
    "superting jobs cancel <job_id>",
  ],
  // folders
  [
    "folders rename",
    "folders.rename",
    "Rename a folder.",
    "superting folders rename <id> --name <n>",
  ],
  ["folders delete", "folders.delete", "Delete a folder.", "superting folders delete <id>"],
  [
    "folders reorder",
    "folders.reorder",
    "Persist a new folder order.",
    "superting folders reorder --folder-ids 1,2,3",
  ],
  // dictionary groups
  ["dict groups list", "dictionary.groups.list", "List the dictionary group tree."],
  ["dict groups create", "dictionary.groups.create", "Create a dictionary group."],
  [
    "dict groups rename",
    "dictionary.groups.rename",
    "Rename a dictionary group.",
    "superting dict groups rename <id> --name <n>",
  ],
  ["dict groups move", "dictionary.groups.move", "Move a group or a dictionary item into a group."],
  [
    "dict groups delete",
    "dictionary.groups.delete",
    "Delete a dictionary group.",
    "superting dict groups delete <id>",
  ],
  // transcriptions
  [
    "transcriptions transcribe",
    "transcriptions.transcribe_file",
    "Transcribe a local audio file on-device.",
    "superting transcriptions transcribe --file-path <f> [--wait false]",
  ],
  [
    "transcriptions retry",
    "transcriptions.retry",
    "Retry a transcription with current settings.",
    "superting transcriptions retry <id>",
  ],
  ["transcriptions clear", "transcriptions.clear", "Delete all transcription history and audio."],
  [
    "transcriptions delete",
    "transcriptions.delete",
    "Delete one transcription record and its audio.",
    "superting transcriptions delete <id>",
  ],
  [
    "transcriptions delete-audio",
    "transcriptions.delete_audio",
    "Delete a transcription's audio, keep the text.",
    "superting transcriptions delete-audio <id>",
  ],
  // audio storage
  ["audio usage", "audio.usage", "Show how much disk retained audio uses."],
  ["audio retention", "audio.retention.set", "Set audio retention days and run cleanup."],
  ["audio compress-all", "audio.compress_all", "Compress every retained audio file."],
  ["audio delete-all", "audio.delete_all", "Delete every retained audio file."],
  // people & contacts
  ["people list", "people.list", "List contact profiles (人名表)."],
  [
    "people get",
    "people.get",
    "Get one contact and its voiceprint metadata.",
    "superting people get <id>",
  ],
  ["people create", "people.create", "Create a contact profile."],
  [
    "people update",
    "people.update",
    "Update a contact profile.",
    "superting people update <id> [--email …]",
  ],
  [
    "people delete",
    "people.delete",
    "Delete a contact and its voiceprints.",
    "superting people delete <id>",
  ],
  [
    "people merge",
    "people.merge",
    "Merge one contact into another.",
    "superting people merge --keep-id <id> --remove-id <id>",
  ],
  ["contacts search", "contacts.search", "Search contact records by name or email."],
  ["contacts upsert", "contacts.upsert", "Create or update a contact record."],
  // speakers
  ["speakers profiles", "speakers.profiles", "List speaker profiles across notes."],
  ["speakers names", "speakers.names", "List known speaker names."],
  [
    "speakers mappings",
    "speakers.mappings",
    "Show a note's speaker → contact mappings.",
    "superting speakers mappings --id <n>",
  ],
  ["speakers assign", "speakers.mapping.set", "Assign a name/contact to a speaker in a note."],
  ["speakers name-add", "speakers.name.upsert", "Create or update a speaker name."],
  [
    "speakers name-delete",
    "speakers.name.delete",
    "Delete a speaker name.",
    "superting speakers name-delete <id>",
  ],
  ["speakers email-attach", "speakers.email.attach", "Attach an email to a speaker profile."],
  // voiceprints
  ["voiceprints segments", "voiceprints.segments", "List auditionable voiceprint segments."],
  ["voiceprints delete-all", "voiceprints.delete_all", "Delete voiceprints (all, or one person)."],
  // chats
  ["chats list", "chats.list", "List agent chat history."],
  [
    "chats messages",
    "chats.messages",
    "Show one conversation's messages.",
    "superting chats messages <id>",
  ],
  [
    "chats for-note",
    "chats.for_note",
    "List the chats attached to a note.",
    "superting chats for-note --id <n>",
  ],
  ["chats create", "chats.create", "Create an agent conversation."],
  ["chats archive", "chats.archive", "Archive a conversation.", "superting chats archive <id>"],
  [
    "chats delete",
    "chats.delete",
    "Permanently delete a conversation.",
    "superting chats delete <id>",
  ],
  // settings & recording
  [
    "settings get",
    "settings.get",
    "Read app settings (credentials redacted).",
    "superting settings get [--key <k>]",
  ],
  ["settings set", "settings.set", "Update one setting (credentials refused)."],
  ["recording status", "recording.status", "Report whether the app is recording."],
  ["recording start", "recording.start", "Start recording into a note."],
  ["recording stop", "recording.stop", "Stop the running recording."],
];

function buildCommandRegistry() {
  const commands = new Map();

  const command = (name, { description, usage, destructive = false, run }) => {
    commands.set(name, { name, description, usage, destructive, run });
  };

  command("ops list", {
    description: "List every capability the app exposes to agents (MCP tool + CLI route + params).",
    usage: "superting ops list",
    run: async ({ bridge }) => bridgeRequest(bridge, "GET", "/v1/operations"),
  });

  // Generic escape hatch: every registered operation is reachable, including
  // ones added after this CLI shipped. Parameter placement (path/query/body) is
  // read from the app's own capability catalog, never guessed here.
  command("call", {
    description:
      "Call any app operation by id (see `ops list`); pass params as --name value or --json '{...}'.",
    usage: "superting call <operation.id> [--json '{...}'] [--param value ...] [--yes]",
    run: async ({ bridge, flags, cliFlags, positional }) => {
      const operationId = positional[0];
      if (!operationId) throw new ArgError("An operation id is required (see: superting ops list)");
      const operation = await loadOperation(bridge, operationId);

      let params = {};
      const jsonArg = last(flags, "json");
      if (jsonArg !== undefined) {
        try {
          const parsed = JSON.parse(jsonArg);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("expected a JSON object");
          }
          params = { ...parsed };
        } catch (err) {
          throw new ArgError(`--json must be a JSON object: ${err.message}`);
        }
      }
      Object.assign(params, paramsFromFlags(operation, flags, params));
      return runOperationRequest(bridge, operation, { params, cliFlags });
    },
  });

  // One thin command per capability family; see OPERATION_COMMANDS.
  for (const [name, operationId, description, usage] of OPERATION_COMMANDS) {
    if (commands.has(name)) {
      throw new Error(`duplicate CLI command "${name}"`);
    }
    command(name, {
      description,
      usage: usage ?? `superting ${name} [--flag value …]`,
      run: async ({ bridge, flags, cliFlags, positional }) => {
        const operation = await loadOperation(bridge, operationId);
        const pathNames = [...(operation.cli?.path ?? "").matchAll(/:([a-z0-9_]+)/g)].map(
          (match) => match[1]
        );
        const positionalParams = {};
        pathNames.forEach((paramName, index) => {
          if (positional[index] !== undefined) positionalParams[paramName] = positional[index];
        });
        const params = paramsFromFlags(operation, flags, positionalParams);
        return runOperationRequest(bridge, operation, { params, cliFlags });
      },
    });
  }

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
        throw new ArgError(
          "Provide at least one of --title/--content/--transcript/--folder-id/--tags/--find"
        );
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
    usage:
      'superting dict replace --words a,b,c --yes  |  superting dict replace --json \'["a","b"]\' --yes',
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
    description:
      "Add or update one replacement rule (existing rule with same from is overwritten).",
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
  // Longest match first, so `notes audio list` wins over a hypothetical `notes`
  // (and `notes list` still wins over `notes`).
  const maxWords = Math.min(4, positional.length);
  for (let words = maxWords; words >= 1; words -= 1) {
    const candidate = positional.slice(0, words).join(" ");
    if (commands.has(candidate)) {
      return { spec: commands.get(candidate), args: positional.slice(words) };
    }
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
    stderr.write(`Unknown command: ${parsed.positional.join(" ")}\n\n${buildUsage(commands)}\n`);
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
