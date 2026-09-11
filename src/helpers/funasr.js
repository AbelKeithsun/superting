/**
 * FunASR (SenseVoice) model management: install detection, download, deletion,
 * diagnostics and the local transcription entry point.
 *
 * Model catalog structure and download endpoint fallback design ported from
 * SmartSub (MIT, Copyright (c) 2024 Lin Xiaodong).
 *
 * Download source order (see docs/funasr-sensevoice-plan.md §5.2):
 *   1. HuggingFace mirror, per-file direct download (primary path)
 *   2. GitHub release tar.bz2 archive (whole model, needs extraction)
 *   3. GitHub release archive via proxy prefix
 *   4. HuggingFace official, per-file direct download (last resort)
 * Mirror/proxy bases can be overridden via SUPERTING_FUNASR_HF_MIRROR /
 * SUPERTING_FUNASR_GH_PROXY environment variables.
 */

const fs = require("fs");
const fsPromises = require("fs").promises;
const path = require("path");
const { spawn } = require("child_process");
const { pipeline } = require("stream/promises");
const debugLogger = require("./debugLogger");
const {
  downloadFile,
  createDownloadSignal,
  cleanupStaleDownloads,
  checkDiskSpace,
} = require("./downloadUtils");
const FunasrServerManager = require("./funasrServer");
const { FUNASR_REQUIRED_FILES } = require("./funasrServer");
const { getModelsDirForService } = require("./modelDirUtils");

const modelRegistryData = require("../models/modelRegistryData.json");

const DEFAULT_HF_MIRROR = "https://hf-mirror.com";
const DEFAULT_HF_OFFICIAL = "https://huggingface.co";
const DEFAULT_GITHUB_BASE = "https://github.com";
const DEFAULT_GH_PROXY_PREFIX = "https://gh-proxy.com";

function normalizeBase(value, fallback) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  let base = value.trim();
  if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
  base = base.replace(/\/+$/, "");
  return base || fallback;
}

function getFunasrEndpoints() {
  return {
    huggingFaceMirror: normalizeBase(
      process.env.SUPERTING_FUNASR_HF_MIRROR,
      DEFAULT_HF_MIRROR
    ),
    huggingFaceOfficial: DEFAULT_HF_OFFICIAL,
    githubBase: DEFAULT_GITHUB_BASE,
    githubProxyPrefix: normalizeBase(
      process.env.SUPERTING_FUNASR_GH_PROXY,
      DEFAULT_GH_PROXY_PREFIX
    ),
  };
}

function getFunasrModelConfig(modelName) {
  const modelInfo = modelRegistryData.funasrModels[modelName];
  if (!modelInfo) return null;
  return {
    size: modelInfo.expectedSizeBytes || modelInfo.sizeMb * 1_000_000,
    language: modelInfo.language,
    supportedLanguages: modelInfo.supportedLanguages || [],
    repo: modelInfo.repo,
    files: modelInfo.files || [],
    requiredFiles: modelInfo.requiredFiles || FUNASR_REQUIRED_FILES,
    downloadUrl: modelInfo.downloadUrl,
    extractDir: modelInfo.extractDir,
  };
}

function getValidModelNames() {
  return Object.keys(modelRegistryData.funasrModels);
}

class FunasrManager {
  constructor() {
    this.currentDownloadProcess = null;
    this.isInitialized = false;
    this.serverManager = new FunasrServerManager();
  }

  getModelsDir() {
    return getModelsDirForService("funasr");
  }

  validateModelName(modelName) {
    const validModels = getValidModelNames();
    if (!validModels.includes(modelName)) {
      throw new Error(
        `Invalid FunASR model: ${modelName}. Valid models: ${validModels.join(", ")}`
      );
    }
    return true;
  }

  getModelPath(modelName) {
    this.validateModelName(modelName);
    return path.join(this.getModelsDir(), modelName);
  }

  async initializeAtStartup(settings = {}) {
    const startTime = Date.now();

    try {
      this.isInitialized = true;

      await cleanupStaleDownloads(this.getModelsDir());

      await this.logDependencyStatus();

      const { localTranscriptionProvider, funasrModel } = settings;

      if (
        localTranscriptionProvider === "funasr" &&
        funasrModel &&
        this.serverManager.isAvailable()
      ) {
        if (this.serverManager.isModelDownloaded(funasrModel)) {
          debugLogger.info("Pre-warming funasr server", { model: funasrModel });

          try {
            const serverStartTime = Date.now();
            await this.serverManager.startServer(funasrModel);
            debugLogger.info("FunASR server pre-warmed successfully", {
              model: funasrModel,
              startupTimeMs: Date.now() - serverStartTime,
            });
          } catch (err) {
            debugLogger.warn("FunASR server pre-warm failed (will start on first use)", {
              error: err.message,
              model: funasrModel,
            });
          }
        } else {
          debugLogger.debug("Skipping funasr server pre-warm: model not downloaded", {
            model: funasrModel,
          });
        }
      } else {
        debugLogger.debug("Skipping funasr server pre-warm", {
          reason:
            localTranscriptionProvider !== "funasr"
              ? "provider not funasr"
              : !funasrModel
                ? "no model selected"
                : "server binary not available",
        });
      }
    } catch (error) {
      debugLogger.warn("FunASR initialization error", { error: error.message });
      this.isInitialized = true;
    }

    debugLogger.info("FunASR initialization complete", {
      totalTimeMs: Date.now() - startTime,
      binaryAvailable: this.serverManager.isAvailable(),
    });
  }

  async logDependencyStatus() {
    const status = {
      sherpaOnnx: {
        available: this.serverManager.isAvailable(),
        path: this.serverManager.getBinaryPath(),
      },
      models: [],
    };

    for (const modelName of getValidModelNames()) {
      const modelPath = this.getModelPath(modelName);
      if (this.serverManager.isModelDownloaded(modelName)) {
        try {
          const modelOnnxPath = path.join(modelPath, "model.int8.onnx");
          const stats = fs.statSync(modelOnnxPath);
          status.models.push({
            name: modelName,
            size: `${Math.round(stats.size / (1024 * 1024))}MB`,
          });
        } catch {}
      }
    }

    debugLogger.info("FunASR dependency check", status);

    const binaryStatus = status.sherpaOnnx.available
      ? `✓ ${status.sherpaOnnx.path}`
      : "✗ Not found";
    const modelsStatus =
      status.models.length > 0
        ? status.models.map((m) => `${m.name}`).join(", ")
        : "None downloaded";

    debugLogger.info(`[FunASR] sherpa-onnx: ${binaryStatus}`);
    debugLogger.info(`[FunASR] Models: ${modelsStatus}`);
  }

  async checkInstallation() {
    const binaryPath = this.serverManager.getBinaryPath();
    if (!binaryPath) {
      return { installed: false, working: false };
    }

    return {
      installed: true,
      working: this.serverManager.isAvailable(),
      path: binaryPath,
    };
  }

  async startServer(modelName) {
    this.validateModelName(modelName);
    return this.serverManager.startServer(modelName);
  }

  async stopServer() {
    await this.serverManager.stopServer();
  }

  getServerStatus() {
    return this.serverManager.getServerStatus();
  }

  async transcribeLocalFunasr(audioBlob, options = {}) {
    debugLogger.logSTTPipeline("transcribeLocalFunasr - start", {
      options,
      audioBlobType: audioBlob?.constructor?.name,
      audioBlobSize: audioBlob?.byteLength || audioBlob?.size || 0,
      serverAvailable: this.serverManager.isAvailable(),
    });

    if (!this.serverManager.isAvailable()) {
      throw new Error(
        "sherpa-onnx binary not found. Please ensure the app is installed correctly."
      );
    }

    const model = options.model || "sensevoice-small";

    if (!this.serverManager.isModelDownloaded(model)) {
      throw new Error(
        `FunASR model "${model}" not downloaded. Please download it from Settings.`
      );
    }

    let audioBuffer;
    if (Buffer.isBuffer(audioBlob)) {
      audioBuffer = audioBlob;
    } else if (ArrayBuffer.isView(audioBlob)) {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset, audioBlob.byteLength);
    } else if (audioBlob instanceof ArrayBuffer) {
      audioBuffer = Buffer.from(audioBlob);
    } else if (typeof audioBlob === "string") {
      audioBuffer = Buffer.from(audioBlob, "base64");
    } else if (audioBlob && audioBlob.buffer && typeof audioBlob.byteLength === "number") {
      audioBuffer = Buffer.from(audioBlob.buffer, audioBlob.byteOffset || 0, audioBlob.byteLength);
    } else {
      throw new Error(`Unsupported audio data type: ${typeof audioBlob}`);
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      throw new Error("Audio buffer is empty - no audio data received");
    }

    debugLogger.logSTTPipeline("transcribeLocalFunasr - processing", {
      bufferSize: audioBuffer.length,
      model,
      language: options.language,
    });

    const startTime = Date.now();
    const result = await this.serverManager.transcribe(audioBuffer, {
      modelName: model,
      language: options.language,
      useItn: options.useItn,
      signal: options.signal,
    });
    const elapsed = Date.now() - startTime;

    debugLogger.logSTTPipeline("transcribeLocalFunasr - completed", {
      elapsed,
      textLength: result.text?.length || 0,
      lang: result.lang,
    });

    return this.parseFunasrResult(result);
  }

  parseFunasrResult(output) {
    debugLogger.debug("parseFunasrResult", {
      hasOutput: !!output,
      hasText: !!output?.text,
      textLength: output?.text?.length || 0,
    });

    if (!output || !output.text) {
      return { success: false, message: "No audio detected" };
    }

    const text = output.text.trim();

    if (!text || text.length === 0) {
      return { success: false, message: "No audio detected" };
    }

    return {
      success: true,
      text,
      // SenseVoice metadata (v1 surfaces detected language only)
      lang: output.lang || null,
      emotion: output.emotion || null,
      event: output.event || null,
    };
  }

  async downloadFunasrModel(modelName, progressCallback = null) {
    this.validateModelName(modelName);
    const modelConfig = getFunasrModelConfig(modelName);

    const modelPath = this.getModelPath(modelName);
    const modelsDir = this.getModelsDir();

    await fsPromises.mkdir(modelsDir, { recursive: true });

    if (this.serverManager.isModelDownloaded(modelName)) {
      return { model: modelName, downloaded: true, path: modelPath, success: true };
    }

    const spaceCheck = await checkDiskSpace(modelsDir, modelConfig.size * 2.5);
    if (!spaceCheck.ok) {
      throw new Error(
        `Not enough disk space to download and extract model. Need ~${Math.round((modelConfig.size * 2.5) / 1_000_000)}MB, ` +
          `only ${Math.round(spaceCheck.availableBytes / 1_000_000)}MB available.`
      );
    }

    const { signal, abort } = createDownloadSignal();
    this.currentDownloadProcess = { abort };

    const totalExpectedBytes = modelConfig.files.reduce(
      (sum, f) => sum + Math.round((f.sizeMb || 0) * 1_000_000),
      0
    );

    const reportProgress = (downloadedBytes, totalBytes) => {
      if (!progressCallback) return;
      progressCallback({
        type: "progress",
        model: modelName,
        downloaded_bytes: downloadedBytes,
        total_bytes: totalBytes,
        percentage: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
      });
    };

    try {
      let downloaded = false;

      // Stage 1: per-file direct download from HF mirror
      try {
        await this._downloadPerFile(modelConfig, modelPath, {
          signal,
          urlsFor: (file) => {
            const endpoints = getFunasrEndpoints();
            return [
              `${endpoints.huggingFaceMirror}/${modelConfig.repo}/resolve/main/${file}`,
            ];
          },
          onProgress: (completedBytes, fileBytes, fileTotal) =>
            reportProgress(completedBytes + fileBytes, totalExpectedBytes),
        });
        downloaded = this.serverManager.isModelDownloaded(modelName);
      } catch (err) {
        if (err.isAbort) throw err;
        debugLogger.warn("FunASR per-file download from HF mirror failed", {
          model: modelName,
          error: err.message,
        });
      }

      // Stage 2 + 3: GitHub release archive, direct then via proxy prefix
      if (!downloaded) {
        const endpoints = getFunasrEndpoints();
        const archiveUrl = modelConfig.downloadUrl;
        for (const url of [
          archiveUrl,
          `${endpoints.githubProxyPrefix}/${archiveUrl}`,
        ]) {
          if (downloaded) break;
          try {
            await fsPromises.mkdir(modelPath, { recursive: true });
            await this._downloadArchive(url, modelConfig, modelPath, {
              signal,
              onProgress: (downloadedBytes, totalBytes) =>
                reportProgress(downloadedBytes, totalBytes || totalExpectedBytes),
            });
            downloaded = this.serverManager.isModelDownloaded(modelName);
          } catch (err) {
            if (err.isAbort) throw err;
            debugLogger.warn("FunASR archive download failed", {
              model: modelName,
              url,
              error: err.message,
            });
          }
        }
      }

      // Stage 4: per-file direct download from HF official
      if (!downloaded) {
        await this._downloadPerFile(modelConfig, modelPath, {
          signal,
          urlsFor: (file) => {
            const endpoints = getFunasrEndpoints();
            return [
              `${endpoints.huggingFaceOfficial}/${modelConfig.repo}/resolve/main/${file}`,
            ];
          },
          onProgress: (completedBytes, fileBytes, fileTotal) =>
            reportProgress(completedBytes + fileBytes, totalExpectedBytes),
        });
        downloaded = this.serverManager.isModelDownloaded(modelName);
      }

      if (!downloaded) {
        await fsPromises.rm(modelPath, { recursive: true, force: true }).catch(() => {});
        throw new Error(
          `Failed to download FunASR model "${modelName}" from all available sources`
        );
      }

      if (progressCallback) {
        progressCallback({ type: "installing", model: modelName, percentage: 100 });
      }

      if (progressCallback) {
        progressCallback({ type: "complete", model: modelName, percentage: 100 });
      }

      if (this.serverManager.isAvailable()) {
        this.serverManager.startServer(modelName).catch((err) => {
          debugLogger.warn("Post-download server pre-warm failed (non-fatal)", {
            error: err.message,
            model: modelName,
          });
        });
      }

      return { model: modelName, downloaded: true, path: modelPath, success: true };
    } catch (error) {
      if (error.isAbort) {
        await fsPromises.rm(modelPath, { recursive: true, force: true }).catch(() => {});
        throw new Error("Download interrupted by user");
      }
      throw error;
    } finally {
      this.currentDownloadProcess = null;
    }
  }

  async _downloadPerFile(modelConfig, targetDir, options = {}) {
    const { signal, urlsFor, onProgress } = options;

    await fsPromises.mkdir(targetDir, { recursive: true });

    let completedExpectedBytes = 0;
    const downloadedFiles = [];

    try {
      for (const file of modelConfig.files) {
        throwIfAborted(signal);
        const fileExpected = Math.round((file.sizeMb || 0) * 1_000_000);
        const destPath = path.join(targetDir, file.name);

        // Skip files already complete from a previous attempt
        try {
          const stats = await fsPromises.stat(destPath);
          if (stats.size >= fileExpected * 0.9) {
            completedExpectedBytes += fileExpected;
            downloadedFiles.push(destPath);
            continue;
          }
        } catch {}

        await downloadFile(urlsFor(file.name), destPath, {
          timeout: 600000,
          signal,
          onProgress: (downloadedBytes, totalBytes) => {
            if (onProgress) {
              onProgress(completedExpectedBytes, Math.min(downloadedBytes, fileExpected), fileExpected);
            }
          },
        });

        const stats = await fsPromises.stat(destPath);
        if (file.sizeMb && stats.size < file.sizeMb * 1_000_000 * 0.9) {
          throw new Error(
            `Downloaded file ${file.name} is truncated (${stats.size} bytes, expected ~${Math.round(file.sizeMb * 1_000_000)})`
          );
        }

        downloadedFiles.push(destPath);
        completedExpectedBytes += fileExpected;
      }

      debugLogger.info("FunASR per-file download complete", {
        files: downloadedFiles,
        targetDir,
      });
    } catch (err) {
      // Remove the partially downloaded file so retries start clean
      const lastFile = modelConfig.files[downloadedFiles.length];
      if (lastFile) {
        await fsPromises
          .unlink(path.join(targetDir, lastFile.name))
          .catch(() => {});
      }
      throw err;
    }
  }

  async _downloadArchive(archiveUrl, modelConfig, targetDir, options = {}) {
    const { signal, onProgress } = options;
    const modelsDir = this.getModelsDir();
    const archivePath = path.join(modelsDir, `funasr-archive-download.tar.bz2`);
    const extractDir = path.join(modelsDir, `temp-extract-archive-${Date.now()}`);

    try {
      await downloadFile(archiveUrl, archivePath, {
        timeout: 600000,
        signal,
        onProgress: (downloadedBytes, totalBytes) => {
          if (onProgress) onProgress(downloadedBytes, totalBytes);
        },
      });

      await fsPromises.mkdir(extractDir, { recursive: true });
      await this._runTarExtract(archivePath, extractDir);

      const sourceDir = await this._findModelSourceDir(extractDir, modelConfig);
      await fsPromises.mkdir(targetDir, { recursive: true });

      for (const file of modelConfig.requiredFiles) {
        const src = path.join(sourceDir, file);
        const dest = path.join(targetDir, file);
        await fsPromises.copyFile(src, dest);
      }

      const missing = modelConfig.requiredFiles.filter(
        (f) => !fs.existsSync(path.join(targetDir, f))
      );
      if (missing.length > 0) {
        throw new Error(`Extracted model is missing required files: ${missing.join(", ")}`);
      }

      debugLogger.info("FunASR archive extracted", { archiveUrl, targetDir });
    } finally {
      await fsPromises.rm(extractDir, { recursive: true, force: true }).catch(() => {});
      await fsPromises.unlink(archivePath).catch(() => {});
    }
  }

  async _findModelSourceDir(extractDir, modelConfig) {
    if (modelConfig.extractDir) {
      const candidate = path.join(extractDir, modelConfig.extractDir);
      if (fs.existsSync(candidate)) return candidate;
    }

    const entries = await fsPromises.readdir(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const candidate = path.join(extractDir, entry.name);
        const hasAll = modelConfig.requiredFiles.every((f) =>
          fs.existsSync(path.join(candidate, f))
        );
        if (hasAll) return candidate;
      }
    }

    const hasAllAtRoot = modelConfig.requiredFiles.every((f) =>
      fs.existsSync(path.join(extractDir, f))
    );
    if (hasAllAtRoot) return extractDir;

    throw new Error(
      `Could not locate model files in extracted archive (looked for: ${modelConfig.requiredFiles.join(", ")})`
    );
  }

  async _runTarExtract(archivePath, extractDir) {
    try {
      await this._runSystemTar(archivePath, extractDir);
      return;
    } catch (err) {
      debugLogger.debug("System tar failed, falling back to JS extraction", {
        error: err.message,
      });
    }

    const unbzip2 = require("unbzip2-stream");
    const tar = require("tar");
    await pipeline(fs.createReadStream(archivePath), unbzip2(), tar.x({ cwd: extractDir }));
  }

  _runSystemTar(archivePath, extractDir) {
    return new Promise((resolve, reject) => {
      const tarProcess = spawn("tar", ["-xjf", archivePath, "-C", extractDir], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stderr = "";

      tarProcess.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      tarProcess.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`tar extraction failed with code ${code}: ${stderr}`));
        }
      });

      tarProcess.on("error", (err) => {
        reject(new Error(`Failed to start tar process: ${err.message}`));
      });
    });
  }

  async cancelDownload() {
    if (this.currentDownloadProcess) {
      this.currentDownloadProcess.abort();
      this.currentDownloadProcess = null;
      return { success: true, message: "Download cancelled" };
    }
    return { success: false, error: "No active download to cancel" };
  }

  async checkModelStatus(modelName) {
    const modelPath = this.getModelPath(modelName);

    if (this.serverManager.isModelDownloaded(modelName)) {
      try {
        const modelOnnxPath = path.join(modelPath, "model.int8.onnx");
        const stats = fs.statSync(modelOnnxPath);
        return {
          model: modelName,
          downloaded: true,
          path: modelPath,
          size_bytes: stats.size,
          size_mb: Math.round(stats.size / (1024 * 1024)),
          success: true,
        };
      } catch {
        return { model: modelName, downloaded: false, success: true };
      }
    }

    return { model: modelName, downloaded: false, success: true };
  }

  async listFunasrModels() {
    const models = getValidModelNames();
    const modelInfo = [];

    for (const model of models) {
      const status = await this.checkModelStatus(model);
      modelInfo.push(status);
    }

    return {
      models: modelInfo,
      cache_dir: this.getModelsDir(),
      success: true,
    };
  }

  async deleteFunasrModel(modelName) {
    const modelPath = this.getModelPath(modelName);

    if (fs.existsSync(modelPath)) {
      try {
        const modelOnnxPath = path.join(modelPath, "model.int8.onnx");
        let freedBytes = 0;

        if (fs.existsSync(modelOnnxPath)) {
          const stats = fs.statSync(modelOnnxPath);
          freedBytes = stats.size;
        }

        fs.rmSync(modelPath, { recursive: true, force: true });

        return {
          model: modelName,
          deleted: true,
          freed_bytes: freedBytes,
          freed_mb: Math.round(freedBytes / (1024 * 1024)),
          success: true,
        };
      } catch (error) {
        return { model: modelName, deleted: false, error: error.message, success: false };
      }
    }

    return { model: modelName, deleted: false, error: "Model not found", success: false };
  }

  async deleteAllFunasrModels() {
    const modelsDir = this.getModelsDir();
    let totalFreed = 0;
    let deletedCount = 0;

    try {
      if (!fs.existsSync(modelsDir)) {
        return { success: true, deleted_count: 0, freed_bytes: 0, freed_mb: 0 };
      }

      const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(modelsDir, entry.name);
          try {
            const modelOnnxPath = path.join(dirPath, "model.int8.onnx");
            if (fs.existsSync(modelOnnxPath)) {
              const stats = fs.statSync(modelOnnxPath);
              totalFreed += stats.size;
            }

            fs.rmSync(dirPath, { recursive: true, force: true });
            deletedCount++;
          } catch {}
        }
      }

      return {
        success: true,
        deleted_count: deletedCount,
        freed_bytes: totalFreed,
        freed_mb: Math.round(totalFreed / (1024 * 1024)),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  async getDiagnostics() {
    const diagnostics = {
      platform: process.platform,
      arch: process.arch,
      resourcesPath: process.resourcesPath || null,
      isPackaged: !!process.resourcesPath && !process.resourcesPath.includes("node_modules"),
      sherpaOnnx: { available: false, path: null },
      modelsDir: this.getModelsDir(),
      models: [],
    };

    const binaryPath = this.serverManager.getBinaryPath();
    if (binaryPath) {
      diagnostics.sherpaOnnx = { available: true, path: binaryPath };
    }

    try {
      const modelsDir = this.getModelsDir();
      if (fs.existsSync(modelsDir)) {
        const entries = fs.readdirSync(modelsDir, { withFileTypes: true });
        diagnostics.models = entries
          .filter((e) => e.isDirectory() && this.serverManager.isModelDownloaded(e.name))
          .map((e) => e.name);
      }
    } catch {}

    return diagnostics;
  }
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    const err = new Error("Download aborted");
    err.isAbort = true;
    throw err;
  }
}

module.exports = FunasrManager;
