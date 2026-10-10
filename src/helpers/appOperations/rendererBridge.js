"use strict";

const { ipcMain, BrowserWindow } = require("electron");
const { OperationError } = require("./registry");
const debugLogger = require("../debugLogger");

/**
 * Main → renderer request/response bridge.
 *
 * Some capabilities cannot be implemented in the main process at all: audio
 * capture lives in a MediaRecorder, the note-action LLM call resolves its
 * provider from renderer settings, and chat turns run in the React app. Those
 * operations dispatch here instead of pretending to work, and they fail loudly
 * with `UNAVAILABLE` when no window is open rather than silently returning
 * stale data.
 */

const REQUEST_CHANNEL = "app-operation-request";
const RESPONSE_CHANNEL = "app-operation-response";
// Note actions allow a 10 minute wall clock; give the bridge a little more.
const DEFAULT_TIMEOUT_MS = 11 * 60 * 1000;

class RendererBridge {
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.registered = false;
  }

  register() {
    if (this.registered) return;
    ipcMain.on(RESPONSE_CHANNEL, (_event, message) => {
      const id = message?.id;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      clearTimeout(entry.timer);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error || "Renderer operation failed"));
    });
    this.registered = true;
  }

  isAvailable() {
    return BrowserWindow.getAllWindows().some((win) => !win.isDestroyed());
  }

  async invoke(channel, payload) {
    this.register();
    const target = BrowserWindow.getAllWindows().find((win) => !win.isDestroyed());
    if (!target) {
      throw OperationError.unavailable(
        "This operation needs the SuperTing window, but none is open. Open the app and retry."
      );
    }

    const id = `op-${Date.now()}-${this.sequence++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          OperationError.unavailable(`Timed out waiting for the SuperTing window (${channel})`)
        );
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      debugLogger.debug("Dispatching app operation to renderer", { channel, id }, "app-operations");
      target.webContents.send(REQUEST_CHANNEL, { id, channel, payload });
    });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  REQUEST_CHANNEL,
  RESPONSE_CHANNEL,
  RendererBridge,
};
