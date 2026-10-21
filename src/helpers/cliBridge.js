const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const debugLogger = require("./debugLogger");
const { ensureMigratedPath } = require("./brandConfig");
const { isPortAvailable } = require("../utils/serverUtils");
const { createAppOperations } = require("./appOperations");
const { buildCliRoutes } = require("./appOperations/cliAdapter");
const { AgentAccessSettings } = require("./agentAccess");

const PORT_RANGE_START = 8200;
const PORT_RANGE_END = 8219;
const HOST = "127.0.0.1";
const BRIDGE_FILE_VERSION = 1;
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const NO_CONTENT = Symbol("CliBridge.NoContent");

/**
 * Capabilities that stay reachable in lean mode even though they are not part
 * of the lean operation set: the catalog route itself (the CLI needs it to
 * resolve commands and to tell "unknown command" from "hidden by lean mode").
 */
const LEAN_MODE_META_OPERATIONS = new Set(["system.operations"]);

function getBridgeFilePath() {
  return path.join(ensureMigratedPath(os.homedir(), "config"), "cli-bridge.json");
}

async function findAvailablePort() {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available ports in range ${PORT_RANGE_START}-${PORT_RANGE_END}`);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > MAX_REQUEST_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(204);
  res.end();
}

function sendV1Error(res, statusCode, code, message) {
  sendJson(res, statusCode, { error: { code, message } });
}

function parseIdParam(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) return null;
  return id;
}

function unwrapMutationResult(result, label) {
  if (!result?.success || !result[label]) {
    throw new Error(result?.error || `Failed to write ${label}`);
  }
  return result[label];
}

function validationError(message) {
  const err = new Error(message);
  err.code = "VALIDATION";
  return err;
}

function parseWordList(value) {
  const words = Array.isArray(value?.words) ? value.words : Array.isArray(value) ? value : null;
  if (!words) {
    throw validationError("Expected a JSON array of words (or {\"words\": [...]})");
  }
  const cleaned = [];
  for (const word of words) {
    if (typeof word !== "string" || !word.trim()) {
      throw validationError("Dictionary words must be non-empty strings");
    }
    cleaned.push(word.trim());
  }
  return cleaned;
}

function parseAliasList(value) {
  const aliases = Array.isArray(value?.aliases) ? value.aliases : Array.isArray(value) ? value : null;
  if (!aliases) {
    throw validationError("Expected a JSON array of aliases (or {\"aliases\": [...]})");
  }
  const cleaned = [];
  for (const alias of aliases) {
    const from = typeof alias?.from === "string" ? alias.from.trim() : "";
    const to = typeof alias?.to === "string" ? alias.to.trim() : "";
    if (!from || !to) {
      throw validationError("Aliases must be objects with non-empty \"from\" and \"to\" strings");
    }
    cleaned.push({ from, to });
  }
  return cleaned;
}

function parseSingleAlias(body) {
  const from = typeof body?.from === "string" ? body.from.trim() : "";
  const to = typeof body?.to === "string" ? body.to.trim() : "";
  if (!from || !to) {
    throw validationError("Expected {\"from\": \"...\", \"to\": \"...\"} with non-empty strings");
  }
  return { from, to };
}

class CliBridge {
  constructor(ipcHandlers, options = {}) {
    this.ipcHandlers = ipcHandlers;
    this.server = null;
    this.port = null;
    this.token = null;
    this.bridgeFilePath = options.bridgeFilePath || getBridgeFilePath();
    this.findPort = options.portFinder || findAvailablePort;
    // Shared with the MCP server: expanding in the app applies to both surfaces.
    this.agentAccess =
      options.agentAccess || new AgentAccessSettings({ homeDir: options.homeDir });
    this.routes = this._buildRouteTable();
  }

  async start() {
    if (this.server) return;

    this.token = crypto.randomBytes(32).toString("hex");
    this.port = await this.findPort();
    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((err) => {
        debugLogger.error("CLI bridge handler error", { error: err.message }, "cli-bridge");
        if (!res.headersSent) {
          sendV1Error(res, 500, "internal_error", "Internal server error");
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        reject(err);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeBridgeFile();
    debugLogger.info("CLI bridge started", { port: this.port }, "cli-bridge");
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => {
      this.server.close(() => resolve());
    });
    this.server = null;
    this.port = null;
    this.token = null;
    this._removeBridgeFile();
    debugLogger.info("CLI bridge stopped", {}, "cli-bridge");
  }

  _writeBridgeFile() {
    const dir = path.dirname(this.bridgeFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({
      version: BRIDGE_FILE_VERSION,
      port: this.port,
      token: this.token,
    });
    fs.writeFileSync(this.bridgeFilePath, payload, { mode: 0o600 });
    // Re-apply mode in case the filesystem ignored the mode arg on create.
    // No-op on Windows ACLs but harmless; swallow errors from exotic filesystems.
    try {
      fs.chmodSync(this.bridgeFilePath, 0o600);
    } catch (err) {
      debugLogger.debug("CLI bridge chmod failed", { error: err.message }, "cli-bridge");
    }
  }

  _removeBridgeFile() {
    try {
      fs.unlinkSync(this.bridgeFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") {
        debugLogger.debug("CLI bridge file removal failed", { error: err.message }, "cli-bridge");
      }
    }
  }

  async _handleRequest(req, res) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) {
      sendV1Error(res, 403, "forbidden", "Forbidden");
      return;
    }

    const auth = req.headers["authorization"] || "";
    const expected = `Bearer ${this.token}`;
    if (
      auth.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    ) {
      sendV1Error(res, 401, "unauthorized", "Unauthorized");
      return;
    }

    const url = new URL(req.url || "/", `http://${HOST}:${this.port}`);
    const route = this._matchRoute(req.method, url.pathname);
    if (!route) {
      sendV1Error(res, 404, "not_found", "Not found");
      return;
    }

    if (!this._isOperationVisible(route.operationId)) {
      sendV1Error(
        res,
        403,
        "mode_locked",
        `Agent access is in lean mode; "${route.operationId}" requires extended mode. ` +
          "Click 扩展 (Extend all capabilities) in SuperTing → 设置 → 集成 → 本地 MCP 访问 to unlock it."
      );
      return;
    }

    let body = {};
    if (req.method !== "GET" && req.method !== "DELETE") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendV1Error(res, 400, "validation_error", err.message);
        return;
      }
    }

    try {
      const result = await route.handler({ params: route.params, query: url.searchParams, body });
      if (result === NO_CONTENT || route.noContent) {
        sendNoContent(res);
        return;
      }
      const status = route.status || 200;
      sendJson(res, status, result);
    } catch (err) {
      this._sendError(res, err);
    }
  }

  _sendError(res, err) {
    if (err.code === "NOT_FOUND") {
      sendV1Error(res, 404, "not_found", err.message);
      return;
    }
    if (err.code === "VALIDATION") {
      sendV1Error(res, 400, "validation_error", err.message);
      return;
    }
    if (err.code === "UNAVAILABLE") {
      sendV1Error(res, 503, "renderer_unavailable", err.message);
      return;
    }
    debugLogger.error("CLI bridge route error", { error: err.message }, "cli-bridge");
    sendV1Error(res, 500, "internal_error", err.message || "Internal server error");
  }

  /**
   * Lean mode only serves the original basic capabilities (plus the catalog
   * route). Everything else is refused here — not silently 404'd — so an agent
   * gets an actionable "expand in the app" message instead of guessing.
   */
  _isOperationVisible(operationId) {
    if (!operationId) return false;
    if (this.agentAccess.getToolset() !== "lean") return true;
    if (LEAN_MODE_META_OPERATIONS.has(operationId)) return true;
    const operation = this.app?.registry?.get(operationId);
    return !!operation?.lean;
  }

  _matchRoute(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const params = route.match(pathname);
      if (params) return { ...route, params };
    }
    return null;
  }

  _buildRouteTable() {
    // Every route is projected from the application operation registry — see
    // src/helpers/appOperations/. Adding a capability there makes it available
    // to the CLI, the MCP server and the renderer at once.
    this.app = createAppOperations(this.ipcHandlers);
    return buildCliRoutes(this.app.registry, this.app.context, {
      getToolset: () => this.agentAccess.getToolset(),
    });
  }
}

module.exports = CliBridge;
module.exports.getBridgeFilePath = getBridgeFilePath;
