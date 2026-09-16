const { net } = require("electron");

const RELEASE_OWNER = "AbelKeithsun";
const RELEASE_REPO = "superting";
const LATEST_RELEASE_URL = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
const RELEASES_PAGE_URL = `https://github.com/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`;
const REQUEST_TIMEOUT_MS = 10000;
const MANUAL_UPDATE_MESSAGE =
  "This build checks GitHub releases manually; download the new version from the release page.";

function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
}

function parseVersionParts(value) {
  return normalizeVersion(value)
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((part) => (Number.isFinite(part) ? part : 0));
}

// Returns true when `candidate` is newer than `current`.
function isNewerVersion(candidate, current) {
  const next = parseVersionParts(candidate);
  const now = parseVersionParts(current);
  const length = Math.max(next.length, now.length);
  for (let i = 0; i < length; i += 1) {
    const left = next[i] ?? 0;
    const right = now[i] ?? 0;
    if (left > right) return true;
    if (left < right) return false;
  }
  return false;
}

class UpdateManager {
  constructor() {
    this.mainWindow = null;
    this.controlPanelWindow = null;
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.windowManager = null;
    this._suppressNotification = false;

    this.setupAutoUpdater();
  }

  setWindows(mainWindow, controlPanelWindow) {
    this.mainWindow = mainWindow;
    this.controlPanelWindow = controlPanelWindow;
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  // Updates are checked against the project's GitHub releases on demand: there
  // is no bundled updater feed, so the app never downloads or installs on its
  // own — it only tells the user a newer version exists and links to it.
  setupAutoUpdater() {
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.isDownloading = false;
    this.isInstalling = false;
    this.lastUpdateInfo = null;
  }

  setupEventHandlers() {
    return;
  }

  notifyRenderers(channel, data) {
    if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
      this.mainWindow.webContents.send(channel, data);
    }
    if (
      this.controlPanelWindow &&
      !this.controlPanelWindow.isDestroyed() &&
      this.controlPanelWindow.webContents
    ) {
      this.controlPanelWindow.webContents.send(channel, data);
    }
  }

  // Electron's net module uses Chromium's network stack, so corporate/system
  // proxies configured on the machine are honoured automatically.
  _requestLatestRelease() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };

      const request = net.request({
        url: LATEST_RELEASE_URL,
        method: "GET",
        redirect: "follow",
      });
      request.setHeader("Accept", "application/vnd.github+json");
      request.setHeader("User-Agent", "SuperTing-UpdateCheck");

      const timer = setTimeout(() => {
        try {
          request.abort();
        } catch {
          // ignore
        }
        finish(reject, new Error("Update check timed out"));
      }, REQUEST_TIMEOUT_MS);

      request.on("response", (response) => {
        let body = "";
        response.on("data", (chunk) => {
          body += chunk.toString();
        });
        response.on("end", () => {
          clearTimeout(timer);
          if (response.statusCode < 200 || response.statusCode >= 300) {
            finish(reject, new Error(`GitHub responded with ${response.statusCode}`));
            return;
          }
          try {
            finish(resolve, JSON.parse(body));
          } catch (error) {
            finish(reject, error);
          }
        });
      });
      request.on("error", (error) => {
        clearTimeout(timer);
        finish(reject, error);
      });
      request.end();
    });
  }

  async checkForUpdates() {
    const { app } = require("electron");
    const currentVersion = app.getVersion();
    try {
      const release = await this._requestLatestRelease();
      const tag = release?.tag_name || release?.name || "";
      const latestVersion = normalizeVersion(tag);
      if (!latestVersion) {
        throw new Error("Release has no version tag");
      }

      const releaseUrl = release?.html_url || RELEASES_PAGE_URL;
      const dmgAsset = (release?.assets || []).find((asset) =>
        String(asset?.name || "").toLowerCase().endsWith(".dmg")
      );
      const available = isNewerVersion(latestVersion, currentVersion);

      this.updateAvailable = available;
      this.lastUpdateInfo = available
        ? {
            version: latestVersion,
            releaseDate: release?.published_at || null,
            releaseNotes: release?.body || "",
            releaseUrl,
            downloadUrl: dmgAsset?.browser_download_url || releaseUrl,
            files: [],
          }
        : null;

      return {
        updateAvailable: available,
        manual: true,
        currentVersion,
        latestVersion,
        releaseUrl,
        downloadUrl: this.lastUpdateInfo?.downloadUrl || releaseUrl,
        message: available ? `Version ${latestVersion} is available.` : "Up to date.",
      };
    } catch (error) {
      return {
        updateAvailable: false,
        manual: true,
        currentVersion,
        error: error?.message || String(error),
        message: "Could not check for updates.",
      };
    }
  }

  // The renderer opens the release page for manual downloads; these stay
  // callable so the existing update UI degrades quietly instead of throwing.
  async downloadUpdate() {
    return {
      success: false,
      manual: true,
      message: MANUAL_UPDATE_MESSAGE,
      releaseUrl: this.lastUpdateInfo?.releaseUrl || RELEASES_PAGE_URL,
    };
  }

  async installUpdate() {
    return {
      success: false,
      manual: true,
      message: MANUAL_UPDATE_MESSAGE,
      releaseUrl: this.lastUpdateInfo?.releaseUrl || RELEASES_PAGE_URL,
    };
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
        disabled: false,
        manual: true,
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  cleanup() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    this.eventListeners = [];
  }
}

module.exports = UpdateManager;
module.exports.isNewerVersion = isNewerVersion;
module.exports.normalizeVersion = normalizeVersion;
