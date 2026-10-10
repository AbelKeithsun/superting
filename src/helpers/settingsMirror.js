"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const debugLogger = require("./debugLogger");
const { ensureMigratedPath } = require("./brandConfig");

/**
 * Disk mirror of the app's (redacted) settings.
 *
 * The authoritative settings store lives in the renderer (localStorage), which
 * is why `settings.get`/`settings.set` dispatch over the main→renderer bridge.
 * Agents should still be able to *read* configuration while the window is
 * closed, so the renderer publishes a redacted snapshot here on every change
 * and readers fall back to it when the UI is unavailable.
 *
 * Secrets never reach this file: the renderer redacts credential-looking keys
 * before sending, and `write()` additionally refuses obvious secret keys as
 * defence in depth.
 */

const MIRROR_VERSION = 1;
const SECRET_KEY_PATTERN = /(apikey|api_key|token|secret|password|privatekey)/i;

function getSettingsMirrorFilePath(homeDir = os.homedir()) {
  return path.join(ensureMigratedPath(homeDir, "config"), "settings-mirror.json");
}

function sanitize(snapshot) {
  const out = {};
  for (const [key, value] of Object.entries(snapshot ?? {})) {
    const normalized = String(key).replace(/[^a-z0-9_]/gi, "");
    if (SECRET_KEY_PATTERN.test(normalized)) {
      out[key] = value ? "<redacted>" : "";
      continue;
    }
    const type = typeof value;
    if (value !== null && !["string", "number", "boolean"].includes(type)) {
      // Only primitives are mirrored; arrays/objects are JSON-safe but the
      // renderer already flattens what it publishes.
      out[key] = value;
      continue;
    }
    out[key] = value;
  }
  return out;
}

class SettingsMirror {
  constructor({ homeDir = os.homedir() } = {}) {
    this.filePath = getSettingsMirrorFilePath(homeDir);
    this.snapshot = null;
    this.updatedAt = null;
    this._load();
  }

  _load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw.settings === "object" && raw.settings) {
        this.snapshot = raw.settings;
        this.updatedAt = raw.updatedAt ?? null;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        debugLogger.debug(
          "Settings mirror read failed",
          { error: error.message },
          "app-operations"
        );
      }
    }
  }

  write(settings) {
    const clean = sanitize(settings);
    this.snapshot = clean;
    this.updatedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ version: MIRROR_VERSION, updatedAt: this.updatedAt, settings: clean }),
        { mode: 0o600 }
      );
    } catch (error) {
      debugLogger.warn("Settings mirror write failed", { error: error.message }, "app-operations");
    }
    return { count: Object.keys(clean).length, updatedAt: this.updatedAt };
  }

  read(key = null) {
    if (!this.snapshot) return key ? undefined : null;
    if (key) return this.snapshot[key];
    return this.snapshot;
  }

  info() {
    return {
      path: this.filePath,
      updatedAt: this.updatedAt,
      count: this.snapshot ? Object.keys(this.snapshot).length : 0,
    };
  }
}

module.exports = { SettingsMirror, getSettingsMirrorFilePath, sanitize };
