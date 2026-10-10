const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const {
  StreamableHTTPServerTransport,
} = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");
const z = require("zod/v4");
const debugLogger = require("./debugLogger");
const { ensureMigratedPath } = require("./brandConfig");
const { isPortAvailable } = require("../utils/serverUtils");
const { version: APP_VERSION } = require("../../package.json");
const {
  createAppOperations,
  listMcpToolNames,
} = require("./appOperations");
const { registerRegistryTools } = require("./appOperations/mcpAdapter");

const HOST = "127.0.0.1";
const DEFAULT_PORT_RANGE = [8220, 8239];
const METADATA_FILE_VERSION = 1;
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };
const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
const MCP_TOOL_NAMES = listMcpToolNames();

function getMcpMetadataFilePath(homeDir = os.homedir()) {
  return path.join(ensureMigratedPath(homeDir, "config"), "mcp-server.json");
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...JSON_HEADERS,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendMcpToolResult(payload) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload),
      },
    ],
  };
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
      if (!raw) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON payload"));
      }
    });
    req.on("error", reject);
  });
}




class McpServerManager {
  constructor(ipcHandlers, options = {}) {
    this.ipcHandlers = ipcHandlers;
    this.homeDir = options.homeDir || os.homedir();
    this.portRange = options.portRange || DEFAULT_PORT_RANGE;
    this.metadataFilePath = options.metadataFilePath || getMcpMetadataFilePath(this.homeDir);
    this.server = null;
    this.port = null;
    this.token = null;
    this.enabled = false;
    this.url = null;
    this.transports = new Map();

    this._loadMetadata();
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: !!this.server,
      url: this.url,
      port: this.port,
      hasToken: !!this.token,
      tools: listMcpToolNames().map((name) => ({ name })),
    };
  }

  getConnectionInfo() {
    const status = this.getStatus();
    return {
      ...status,
      token: this.token,
      metadataPath: this.metadataFilePath,
    };
  }

  async setEnabled(enabled) {
    this.enabled = !!enabled;
    if (this.enabled) {
      await this.start();
    } else {
      await this.stop();
      this._writeMetadata();
    }
    return this.getStatus();
  }

  async rotateToken() {
    this.token = crypto.randomBytes(32).toString("hex");
    if (this.enabled && !this.server) await this.start();
    this._writeMetadata();
    return this.getConnectionInfo();
  }

  async start() {
    if (this.server) return;
    if (!this.enabled) return;

    if (!this.token) this.token = crypto.randomBytes(32).toString("hex");
    this.port = await this._findAvailablePort();
    this.url = `http://${HOST}:${this.port}/mcp`;

    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res).catch((error) => {
        debugLogger.error("MCP server request failed", { error: error.message }, "mcp");
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      });
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server = null;
        reject(error);
      };
      this.server.once("error", onError);
      this.server.listen(this.port, HOST, () => {
        this.server.removeListener("error", onError);
        resolve();
      });
    });

    this._writeMetadata();
    debugLogger.info("MCP server started", { port: this.port }, "mcp");
  }

  async stop() {
    if (!this.server) {
      this.port = null;
      this.url = null;
      return;
    }
    for (const { transport, mcpServer } of this.transports.values()) {
      await transport.close().catch(() => {});
      await mcpServer.close().catch(() => {});
    }
    this.transports.clear();
    await new Promise((resolve) => this.server.close(() => resolve()));
    this.server = null;
    this.port = null;
    this.url = null;
    debugLogger.info("MCP server stopped", {}, "mcp");
  }

  async _handleRequest(req, res) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id",
      });
      res.end();
      return;
    }

    if (new URL(req.url || "/", `http://${HOST}:${this.port}`).pathname !== "/mcp") {
      sendJson(res, 404, { error: { code: "not_found", message: "Not found" } });
      return;
    }

    if (!this._isAuthorized(req)) {
      sendJson(res, 401, { error: { code: "unauthorized", message: "Unauthorized" } });
      return;
    }

    if (req.method === "POST") {
      await this._handleMcpPost(req, res);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"];
      const session = sessionId ? this.transports.get(sessionId) : null;
      if (!session) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: { code: "method_not_allowed", message: "Method not allowed" } });
  }

  async _handleMcpPost(req, res) {
    let parsedBody;
    try {
      parsedBody = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: error.message },
        id: null,
      });
      return;
    }

    const sessionId = req.headers["mcp-session-id"];
    const existing = sessionId ? this.transports.get(sessionId) : null;
    if (existing) {
      await existing.transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (sessionId || !isInitializeRequest(parsedBody)) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: No valid session ID provided" },
        id: null,
      });
      return;
    }

    const mcpServer = this._createMcpServer();
    let transport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (newSessionId) => {
        this.transports.set(newSessionId, { transport, mcpServer });
      },
    });
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) this.transports.delete(closedSessionId);
    };
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  _isAuthorized(req) {
    const remote = req.socket?.remoteAddress;
    if (!remote || !LOOPBACK_ADDRESSES.has(remote)) return false;
    const auth = req.headers.authorization || "";
    const expected = `Bearer ${this.token}`;
    if (auth.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  }

  _createMcpServer() {
    const server = new McpServer(
      {
        name: "superting-local",
        version: APP_VERSION,
      },
      {
        instructions:
          "Use SuperTing tools for the user's local notes, folders, dictionary, and transcription text. Data is local to this desktop app. Do not request or expose raw audio; only audio metadata is available.",
      }
    );

    this._registerTools(server);
    return server;
  }

  _registerTools(server) {
    // Every MCP tool is projected from the application operation registry —
    // see src/helpers/appOperations/. The CLI bridge serves the same
    // operations, so the two surfaces can no longer drift apart.
    const app = createAppOperations(this.ipcHandlers);
    this.app = app;
    registerRegistryTools(server, app.registry, {
      z,
      sendMcpToolResult,
      context: app.context,
    });
  }

  async _findAvailablePort() {
    const [start, end] = this.portRange;
    for (let port = start; port <= end; port++) {
      if (await isPortAvailable(port)) return port;
    }
    throw new Error(`No available ports in range ${start}-${end}`);
  }

  _loadMetadata() {
    try {
      const metadata = JSON.parse(fs.readFileSync(this.metadataFilePath, "utf8"));
      this.enabled = !!metadata.enabled;
      this.token = typeof metadata.token === "string" ? metadata.token : null;
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger.debug("MCP metadata read failed", { error: error.message }, "mcp");
      }
    }
  }

  _writeMetadata() {
    const dir = path.dirname(this.metadataFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const metadata = {
      version: METADATA_FILE_VERSION,
      enabled: this.enabled,
      running: !!this.server,
      url: this.url,
      port: this.port,
      token: this.token,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.metadataFilePath, JSON.stringify(metadata), { mode: 0o600 });
    try {
      fs.chmodSync(this.metadataFilePath, 0o600);
    } catch (error) {
      debugLogger.debug("MCP metadata chmod failed", { error: error.message }, "mcp");
    }
  }
}

module.exports = McpServerManager;
module.exports.getMcpMetadataFilePath = getMcpMetadataFilePath;
module.exports.MCP_TOOL_NAMES = MCP_TOOL_NAMES;
