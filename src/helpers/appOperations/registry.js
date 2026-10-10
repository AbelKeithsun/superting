"use strict";

/**
 * The application operation registry: ONE definition per capability, consumed by
 * every machine surface.
 *
 * SuperTing exposes its features three ways — renderer IPC, the local MCP server
 * (src/helpers/mcpServerManager.js) and the agent CLI bridge
 * (src/helpers/cliBridge.js). Those surfaces used to be written by hand, and had
 * already drifted: the MCP tool list could not write dictionary entries, its
 * `search_notes` skipped the semantic index, the bridge exposed two transcription
 * deletes that no CLI command ever called, and neither surface could run a note
 * action such as 生成会议纪要.
 *
 * New capabilities now get defined once, here, and projected automatically:
 *   - `mcp`  → `mcpAdapter.js` registers a tool per operation
 *   - `cli`  → `cliAdapter.js` registers an HTTP route per operation
 * A parity test (test/helpers/appOperations.test.js) fails the build when an
 * operation is missing from a surface without an explicit, reasoned exemption.
 *
 * ## Operation shape
 *
 * ```js
 * {
 *   id: "notes.list",                 // stable, dotted, unique
 *   title: "List notes",              // short human label
 *   description: "…",                 // shown to MCP clients and in docs
 *   policy: "read" | "write" | "destructive" | "blocked",
 *   params: {                          // declarative; adapters derive schemas
 *     limit: { type: "number", description: "…", default: 100 },
 *     tags: { type: "array", items: "string" },
 *   },
 *   mcp: { name: "list_notes" },       // omit to exclude (needs excludeReason)
 *   cli: {
 *     method: "GET",
 *     path: "/v1/notes/list",          // ":name" marks a path parameter
 *     params: { limit: "query" },       // name → path | query | body
 *     command: "notes list",            // ergonomic CLI command, for docs
 *     status: 201,                      // optional success status override
 *   },
 *   rendererRequired: false,            // true when it must run in the renderer
 *   handler: async (params, ctx) => ({ data }),
 * }
 * ```
 */

class OperationError extends Error {
  constructor(message, code = "INTERNAL") {
    super(message);
    this.name = "OperationError";
    this.code = code;
  }

  static validation(message) {
    return new OperationError(message, "VALIDATION");
  }

  static notFound(message) {
    return new OperationError(message, "NOT_FOUND");
  }

  static unavailable(message) {
    return new OperationError(message, "UNAVAILABLE");
  }
}

const POLICIES = new Set(["read", "write", "destructive", "blocked"]);
const PARAM_TYPES = new Set(["string", "number", "boolean", "array", "object"]);
const CLI_LOCATIONS = new Set(["path", "query", "body"]);

function assert(condition, message) {
  if (!condition) throw new Error(`[appOperations] ${message}`);
}

function validateParam(name, spec, operationId) {
  assert(spec && typeof spec === "object", `${operationId}: param "${name}" must be an object`);
  assert(
    PARAM_TYPES.has(spec.type),
    `${operationId}: param "${name}" has unsupported type "${spec.type}"`
  );
  if (spec.type === "array") {
    assert(spec.items, `${operationId}: array param "${name}" needs items`);
  }
  return spec;
}

function validateOperation(operation) {
  assert(operation && typeof operation === "object", "operation must be an object");
  const { id, title, description, policy, handler, params } = operation;
  assert(
    typeof id === "string" && /^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(id),
    `bad operation id: ${id}`
  );
  assert(typeof title === "string" && title, `${id}: title is required`);
  assert(typeof description === "string" && description, `${id}: description is required`);
  assert(POLICIES.has(policy), `${id}: policy must be one of ${[...POLICIES].join(", ")}`);
  assert(typeof handler === "function", `${id}: handler is required`);

  const paramSpecs = params ?? {};
  for (const [name, spec] of Object.entries(paramSpecs)) validateParam(name, spec, id);

  const mcp = operation.mcp === false ? null : (operation.mcp ?? null);
  const cli = operation.cli === false ? null : (operation.cli ?? null);
  assert(
    mcp || cli,
    `${id}: must be exposed on at least one machine surface (or not exist at all)`
  );
  if (mcp) {
    assert(
      typeof mcp.name === "string" && /^[a-z][a-z0-9_]*$/.test(mcp.name),
      `${id}: mcp.name must be snake_case`
    );
    if (mcp.serialize !== undefined) {
      assert(typeof mcp.serialize === "function", `${id}: mcp.serialize must be a function`);
    }
  }
  if (cli) {
    assert(typeof cli.method === "string" && cli.method, `${id}: cli.method is required`);
    assert(
      typeof cli.path === "string" && cli.path.startsWith("/v1/"),
      `${id}: cli.path must start with /v1/`
    );
    const declared = new Set([
      ...Object.keys(paramSpecs),
      // Route parameters that are not operation params (rare) still need a home.
      ...Object.keys(cli.params ?? {}),
    ]);
    for (const [name, location] of Object.entries(cli.params ?? {})) {
      assert(CLI_LOCATIONS.has(location), `${id}: cli param "${name}" has bad location`);
      assert(declared.has(name), `${id}: cli param "${name}" is not declared in params`);
    }
    const pathParams = [...cli.path.matchAll(/:([a-z0-9_]+)/g)].map((m) => m[1]);
    for (const name of pathParams) {
      assert(
        (cli.params ?? {})[name] === "path",
        `${id}: path parameter ":${name}" must be declared as a path param`
      );
    }
  }
  if (!mcp || !cli) {
    assert(
      typeof operation.excludeReason === "string" && operation.excludeReason,
      `${id}: an operation missing from MCP or CLI needs excludeReason`
    );
  }

  return {
    id,
    title,
    description,
    policy,
    params: paramSpecs,
    mcp: mcp ? { ...mcp, serialize: mcp.serialize ?? null } : null,
    cli: cli ? { ...cli, serialize: cli.serialize ?? null } : null,
    rendererRequired: !!operation.rendererRequired,
    excludeReason: operation.excludeReason ?? null,
    handler,
  };
}

function coerceParam(name, spec, value) {
  if (value === undefined || value === null || value === "") {
    return spec.default !== undefined ? spec.default : undefined;
  }
  switch (spec.type) {
    case "number": {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) throw OperationError.validation(`Invalid number for "${name}"`);
      return num;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      const text = String(value).toLowerCase();
      if (["true", "1", "yes"].includes(text)) return true;
      if (["false", "0", "no"].includes(text)) return false;
      throw OperationError.validation(`Invalid boolean for "${name}"`);
    }
    case "array": {
      if (Array.isArray(value)) return value;
      if (typeof value === "string") {
        return value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
      }
      throw OperationError.validation(`Invalid array for "${name}"`);
    }
    case "object": {
      if (value && typeof value === "object" && !Array.isArray(value)) return value;
      if (typeof value === "string") {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch {
          // fall through to the validation error below
        }
      }
      throw OperationError.validation(`Invalid object for "${name}"`);
    }
    default:
      return String(value);
  }
}

/** Normalize raw params (CLI strings or MCP values) against the declaration. */
function normalizeParams(operation, raw = {}) {
  const out = {};
  for (const [name, spec] of Object.entries(operation.params)) {
    if (!(name in raw)) {
      if (spec.default !== undefined) out[name] = spec.default;
      if (spec.required) throw OperationError.validation(`"${name}" is required`);
      continue;
    }
    const value = coerceParam(name, spec, raw[name]);
    if (value === undefined) {
      if (spec.required) throw OperationError.validation(`"${name}" is required`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(value)) {
      throw OperationError.validation(`"${name}" must be one of: ${spec.enum.join(", ")}`);
    }
    out[name] = value;
  }
  // Unknown keys are dropped rather than rejected: MCP clients (and the generic
  // `superting call` escape hatch) may carry extras, and the surfaces share this
  // normalizer.
  return out;
}

class AppRegistry {
  constructor(operations) {
    this.operations = operations;
    this.byId = new Map(operations.map((operation) => [operation.id, operation]));
    this.byMcpName = new Map(
      operations.filter((op) => op.mcp).map((operation) => [operation.mcp.name, operation])
    );
    const routes = new Map();
    for (const operation of operations) {
      if (!operation.cli) continue;
      const key = `${operation.cli.method} ${operation.cli.path}`;
      assert(!routes.has(key), `duplicate CLI route ${key}`);
      routes.set(key, operation);
    }
    this.byRoute = routes;
  }

  list() {
    return this.operations;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  /** Look up an operation the way an MCP client would (by tool name). */
  getByMcpName(name) {
    return this.byMcpName.get(name) ?? null;
  }

  async invoke(id, rawParams, extraContext) {
    const operation = this.byId.get(id);
    if (!operation) throw OperationError.notFound(`Unknown operation: ${id}`);
    const params = normalizeParams(operation, rawParams);
    return operation.handler(params, { ...extraContext, operation });
  }
}

/**
 * Validate an operation list and wrap it in a registry.
 * Throws on duplicate ids / MCP names / CLI routes so a bad definition never
 * reaches the surfaces at runtime.
 */
function createRegistry(operationList) {
  assert(Array.isArray(operationList) && operationList.length > 0, "no operations defined");
  const operations = operationList.map(validateOperation);

  const ids = new Set();
  const mcpNames = new Set();
  for (const operation of operations) {
    assert(!ids.has(operation.id), `duplicate operation id ${operation.id}`);
    ids.add(operation.id);
    if (operation.mcp) {
      assert(
        !mcpNames.has(operation.mcp.name),
        `duplicate MCP tool name ${operation.mcp.name} (${operation.id})`
      );
      mcpNames.add(operation.mcp.name);
    }
  }

  return new AppRegistry(operations);
}

module.exports = {
  AppRegistry,
  OperationError,
  POLICIES,
  createRegistry,
  normalizeParams,
  validateOperation,
};
