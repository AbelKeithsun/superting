"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const { ensureMigratedPath } = require("./brandConfig");

/**
 * The capability mode shared by every machine surface (local MCP server and the
 * `superting` CLI bridge).
 *
 * `lean` exposes the original, hand-written MCP surface — 14 basic tools for
 * notes, folders, transcriptions, dictionary and tags — and is the default so a
 * freshly enabled agent integration cannot read or change anything beyond the
 * basics. `extended` exposes the full operation registry (meetings, note
 * actions, audio, people/voiceprints, chats, settings, recording…).
 *
 * The mode is stored once on disk and read by both surfaces, so they cannot
 * disagree: expanding in the app is one click and applies to MCP and the CLI at
 * the same time. Changing it is a human action in the app UI — the CLI itself
 * has no self-expand command.
 */

const TOOLSETS = ["lean", "extended"];
const DEFAULT_TOOLSET = "lean";
const AGENT_ACCESS_FILE_VERSION = 1;

function normalizeToolset(value) {
  return TOOLSETS.includes(value) ? value : null;
}

function getAgentAccessFilePath(homeDir = os.homedir()) {
  return path.join(ensureMigratedPath(homeDir, "config"), "agent-access.json");
}

function readStoredToolset(filePath) {
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizeToolset(payload?.toolset);
  } catch (error) {
    if (error.code !== "ENOENT") {
      debugLogger.debug("Agent access settings read failed", { error: error.message }, "agents");
    }
    return null;
  }
}

class AgentAccessSettings {
  constructor(options = {}) {
    this.homeDir = options.homeDir || os.homedir();
    this.filePath = options.filePath || getAgentAccessFilePath(this.homeDir);
    this.toolset =
      normalizeToolset(options.toolset) || readStoredToolset(this.filePath) || DEFAULT_TOOLSET;
    this.listeners = new Set();
  }

  getToolset() {
    return this.toolset;
  }

  isLean() {
    return this.toolset === "lean";
  }

  /**
   * Persist a new mode and notify every subscribed surface. Returns the
   * normalized mode; throws on an unknown value or a write failure (callers
   * surface that error to the user instead of silently pretending to expand).
   */
  setToolset(value) {
    const toolset = normalizeToolset(value);
    if (!toolset) {
      throw new Error(`Unknown agent toolset "${value}" (expected ${TOOLSETS.join(" or ")})`);
    }
    if (toolset === this.toolset) return toolset;

    this._persist(toolset);
    this.toolset = toolset;
    for (const listener of this.listeners) {
      try {
        listener(toolset);
      } catch (error) {
        debugLogger.error("Agent toolset listener failed", { error: error.message }, "agents");
      }
    }
    return toolset;
  }

  /** Subscribe to mode changes; returns an unsubscribe function. */
  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _persist(toolset) {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      version: AGENT_ACCESS_FILE_VERSION,
      toolset,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.filePath, JSON.stringify(payload), { mode: 0o600 });
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      debugLogger.debug("Agent access settings chmod failed", { error: error.message }, "agents");
    }
  }
}

module.exports = {
  AGENT_ACCESS_FILE_VERSION,
  AgentAccessSettings,
  DEFAULT_TOOLSET,
  TOOLSETS,
  getAgentAccessFilePath,
  normalizeToolset,
};
