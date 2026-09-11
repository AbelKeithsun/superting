const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const debugLogger = require("./debugLogger");
const os = require("os");
const {
  findAvailablePort,
  resolveBinaryPath,
  gracefulStopProcess,
} = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const sidecarPidFile = require("./sidecarPidFile");
const { createAbortError, throwIfAborted } = require("./ffmpegUtils");
const { resolveFunasrLanguage } = require("./funasrLanguage");

// Distinct port range from parakeet (6006-6029) so both sherpa-onnx WS
// servers can coexist without fighting over ports.
const PORT_RANGE_START = 6030;
const PORT_RANGE_END = 6053;
const STARTUP_TIMEOUT_MS = 60000;
const HEALTH_CHECK_INTERVAL_MS = 5000;
const TRANSCRIPTION_TIMEOUT_MS = 300000;

// SenseVoice reports lang/emotion/event as <|zh|>/<|NEUTRAL|>/<|Speech|>
// (verified against v1.12.23 binary output); strip the decoration so callers
// can compare/display the bare value.
function stripSenseVoiceTag(value) {
  if (typeof value !== "string") return null;
  const stripped = value.replace(/^<\|([^|]*)\|>$/, "$1").trim();
  return stripped || null;
}

class FunasrWsServer {
  constructor() {
    this.process = null;
    this.port = null;
    this.ready = false;
    this.modelName = null;
    this.modelDir = null;
    this.language = null;
    this.useItn = null;
    this.startupPromise = null;
    this.healthCheckInterval = null;
    this.cachedWsBinaryPath = null;
  }

  getWsBinaryPath() {
    if (this.cachedWsBinaryPath) return this.cachedWsBinaryPath;

    const platformArch = `${process.platform}-${process.arch}`;
    const binaryName =
      process.platform === "win32"
        ? `sherpa-onnx-ws-${platformArch}.exe`
        : `sherpa-onnx-ws-${platformArch}`;

    const resolved = resolveBinaryPath(binaryName);
    if (resolved) this.cachedWsBinaryPath = resolved;
    return resolved;
  }

  isAvailable() {
    return this.getWsBinaryPath() !== null;
  }

  async start(modelName, modelDir, options = {}) {
    if (this.startupPromise) return this.startupPromise;
    const language = resolveFunasrLanguage(options.language);
    const useItn = options.useItn !== false;
    if (
      this.ready &&
      this.modelName === modelName &&
      this.language === language &&
      this.useItn === useItn
    ) {
      return;
    }
    if (this.process) await this.stop();

    this.startupPromise = this._doStart(modelName, modelDir, language, useItn);
    try {
      await this.startupPromise;
    } finally {
      this.startupPromise = null;
    }
  }

  async _doStart(modelName, modelDir, language, useItn) {
    const wsBinary = this.getWsBinaryPath();
    if (!wsBinary) throw new Error("sherpa-onnx WS server binary not found");
    if (!fs.existsSync(modelDir)) throw new Error(`Model directory not found: ${modelDir}`);

    this.port = await findAvailablePort(PORT_RANGE_START, PORT_RANGE_END);
    this.modelName = modelName;
    this.modelDir = modelDir;
    this.language = language;
    this.useItn = useItn;

    // SenseVoice-Small via sherpa-onnx offline WS server. Do NOT pass
    // --model-type (sense_voice is not a legal value there; leaving it empty
    // triggers auto-detection which constructs the SenseVoice impl), and do
    // NOT pass --vad-* / --silero-vad-* flags — the offline recognizer config
    // has no VAD field, so they would be silently ignored.
    const args = [
      `--tokens=${path.join(modelDir, "tokens.txt")}`,
      `--sense-voice-model=${path.join(modelDir, "model.int8.onnx")}`,
      `--sense-voice-language=${language}`,
      `--sense-voice-use-itn=${useItn}`,
      `--port=${this.port}`,
      `--num-threads=${Math.max(1, Math.min(4, Math.floor(os.cpus().length * 0.75)))}`,
    ];

    debugLogger.debug("Starting funasr WS server", { port: this.port, modelName, language, useItn, args });

    this.process = spawn(wsBinary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      cwd: getSafeTempDir(),
      detached: process.platform !== "win32",
    });
    sidecarPidFile.write("funasr", this.process.pid);

    let stderrBuffer = "";
    let exitCode = null;
    let readyResolve = null;
    const readyFromStderr = new Promise((resolve) => {
      readyResolve = resolve;
    });

    this.process.stdout.on("data", (data) => {
      debugLogger.debug("funasr-ws stdout", { data: data.toString().trim() });
    });

    this.process.stderr.on("data", (data) => {
      stderrBuffer += data.toString();
      debugLogger.debug("funasr-ws stderr", { data: data.toString().trim() });
      if (data.toString().includes("Listening on:")) {
        readyResolve(true);
      }
    });

    this.process.on("error", (error) => {
      debugLogger.error("funasr-ws process error", { error: error.message });
      this.ready = false;
      readyResolve(false);
    });

    this.process.on("close", (code) => {
      exitCode = code;
      debugLogger.debug("funasr-ws process exited", { code });
      this.ready = false;
      this.process = null;
      this.stopHealthCheck();
      sidecarPidFile.clear("funasr");
      readyResolve(false);
    });

    await this._waitForReady(readyFromStderr, () => ({ stderr: stderrBuffer, exitCode }));
    this._startHealthCheck();

    debugLogger.info("funasr-ws server started successfully", {
      port: this.port,
      model: modelName,
      language,
    });

    await this._warmUp();
  }

  async _warmUp() {
    try {
      const sampleRate = 16000;
      const numSamples = sampleRate;
      const silentSamples = Buffer.alloc(numSamples * 4);
      await this.transcribe(silentSamples, sampleRate);
      debugLogger.debug("funasr-ws warm-up inference complete");
    } catch (err) {
      debugLogger.warn("funasr-ws warm-up failed (non-fatal)", {
        error: err.message,
      });
    }
  }

  async _waitForReady(readySignal, getProcessInfo) {
    const startTime = Date.now();

    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(
        () => reject(new Error(`funasr-ws failed to start within ${STARTUP_TIMEOUT_MS}ms`)),
        STARTUP_TIMEOUT_MS
      );
    });

    const ready = await Promise.race([readySignal, timeoutPromise]);

    if (!ready) {
      const info = getProcessInfo ? getProcessInfo() : {};
      const stderr = info.stderr ? info.stderr.trim().slice(0, 200) : "";
      const details = stderr || (info.exitCode !== null ? `exit code: ${info.exitCode}` : "");
      throw new Error(`funasr-ws process died during startup${details ? `: ${details}` : ""}`);
    }

    this.ready = true;
    debugLogger.debug("funasr-ws ready", { startupTimeMs: Date.now() - startTime });
  }

  _isProcessAlive() {
    if (!this.process || this.process.killed) return false;
    try {
      process.kill(this.process.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  _startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      if (!this.process) {
        this.stopHealthCheck();
        return;
      }

      if (!this._isProcessAlive()) {
        debugLogger.warn("funasr-ws health check failed: process not alive");
        this.ready = false;
        this.stopHealthCheck();
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  stopHealthCheck() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  transcribe(samplesBuffer, sampleRate, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);

    if (!this.ready || !this.process) {
      throw new Error("funasr-ws server is not running");
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let result = "";
      let settled = false;
      let ws = null;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanupAbort();
        try {
          ws?.close();
        } catch {}
        reject(new Error("funasr-ws transcription timed out"));
      }, TRANSCRIPTION_TIMEOUT_MS);

      const cleanupAbort = signal
        ? (() => {
            const abortHandler = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timeout);
              try {
                ws?.close();
              } catch {}
              reject(createAbortError(signal));
            };
            signal.addEventListener("abort", abortHandler, { once: true });
            return () => signal.removeEventListener("abort", abortHandler);
          })()
        : () => {};

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        cleanupAbort();
        fn(value);
      };

      ws = new WebSocket(`ws://127.0.0.1:${this.port}`);

      ws.on("open", () => {
        // sherpa-onnx offline WS binary protocol:
        // [int32LE sample_rate][int32LE num_audio_bytes][float32 samples...]
        const message = Buffer.alloc(8 + samplesBuffer.length);
        message.writeInt32LE(sampleRate, 0);
        message.writeInt32LE(samplesBuffer.length, 4);
        samplesBuffer.copy(message, 8);

        debugLogger.debug("funasr-ws sending audio", {
          samplesBytes: samplesBuffer.length,
          sampleRate,
        });

        ws.send(message, (err) => {
          if (err) {
            debugLogger.error("funasr-ws send error", { error: err.message });
          }
        });
      });

      ws.on("message", (data) => {
        result += data.toString();
        ws.send("Done");
      });

      ws.on("close", (code) => {
        if (settled) return;
        const elapsed = Date.now() - startTime;

        debugLogger.debug("funasr-ws transcription completed", {
          elapsed,
          code,
          resultLength: result.length,
          resultPreview: result.slice(0, 200),
        });

        try {
          const parsed = JSON.parse(result);
          // SenseVoice exposes language/emotion/event alongside the text
          // (unlike parakeet, which only yields text). timestamps are
          // per-token and window-local, so they are surfaced as-is for
          // callers that want them.
          settle(resolve, {
            text: (parsed.text || "").trim(),
            lang: stripSenseVoiceTag(parsed.lang),
            emotion: stripSenseVoiceTag(parsed.emotion),
            event: stripSenseVoiceTag(parsed.event),
            timestamps: Array.isArray(parsed.timestamps) ? parsed.timestamps : null,
            durations: Array.isArray(parsed.durations) ? parsed.durations : null,
            elapsed,
          });
        } catch {
          settle(resolve, { text: result.trim(), elapsed });
        }
      });

      ws.on("error", (error) => {
        settle(reject, new Error(`funasr-ws transcription failed: ${error.message}`));
      });
    });
  }

  async stop() {
    this.stopHealthCheck();

    if (!this.process) {
      this.ready = false;
      return;
    }

    debugLogger.debug("Stopping funasr-ws server");

    try {
      await gracefulStopProcess(this.process);
    } catch (error) {
      debugLogger.error("Error stopping funasr-ws server", { error: error.message });
    }

    this.process = null;
    this.ready = false;
    this.port = null;
    this.modelName = null;
    this.modelDir = null;
    this.language = null;
    this.useItn = null;
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      running: this.ready && this.process !== null,
      port: this.port,
      modelName: this.modelName,
      language: this.language,
    };
  }
}

module.exports = FunasrWsServer;
