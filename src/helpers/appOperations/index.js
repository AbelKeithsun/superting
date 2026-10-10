"use strict";

const { createRegistry } = require("./registry");
const { coreOperations } = require("./coreOperations");
const { actionOperations } = require("./actionOperations");
const { RendererBridge } = require("./rendererBridge");
const { buildCliRoutes } = require("./cliAdapter");

/**
 * Build (once per IPC-handler instance) the application operation registry and
 * the context its handlers run against.
 *
 * The registry is process-wide state derived from the app's own managers, so
 * both the MCP server and the CLI bridge consume the same instance — a
 * capability added once is immediately available on every machine surface.
 */

let cached = null;

function buildOperationList() {
  return [...coreOperations(), ...actionOperations()];
}

function buildContext(ipcHandlers, renderer) {
  return {
    ipc: ipcHandlers,
    db: ipcHandlers.databaseManager,
    broadcast: (channel, payload) => ipcHandlers.broadcastToWindows(channel, payload),
    renderer,
  };
}

function createAppOperations(ipcHandlers) {
  if (cached && cached.ipcHandlers === ipcHandlers) return cached.app;

  const renderer = new RendererBridge();
  const context = buildContext(ipcHandlers, renderer);
  const registry = createRegistry(buildOperationList());
  context.registry = registry;

  const app = {
    registry,
    context,
    renderer,
    operations: registry.list(),
    mcpToolNames: registry
      .list()
      .filter((operation) => operation.mcp)
      .map((operation) => operation.mcp.name),
    cliRoutes: buildCliRoutes(registry, context),
  };

  cached = { ipcHandlers, app };
  return app;
}

/** Tool names without needing an IpcHandlers instance (status API, tests, docs). */
function listMcpToolNames() {
  return createRegistry(buildOperationList())
    .list()
    .filter((operation) => operation.mcp)
    .map((operation) => operation.mcp.name);
}

module.exports = { createAppOperations, listMcpToolNames };
