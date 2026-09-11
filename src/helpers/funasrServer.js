const fs = require("fs");
const path = require("path");
const debugLogger = require("./debugLogger");
const { getModelsDirForService } = require("./modelDirUtils");
const {
  isWavFormat,
  convertToWav,
  wavToFloat32Samples,
  computeFloat32RMS,
  throwIfAborted,
} = require("./ffmpegUtils");
const { getSafeTempDir } = require("./safeTempDir");
const FunasrWsServer = require("./funasrWsServer");

const SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 4; // float32
// SenseVoice is non-autoregressive and handles longer windows well; 30s halves
// the round-trips vs parakeet's 15s while staying far below the ws-server's
// --max-utterance-length=300s limit (longer messages get the connection cut).
const MAX_SEGMENT_SECONDS = 30;
const MAX_SEGMENT_BYTES = MAX_SEGMENT_SECONDS * SAMPLE_RATE * BYTES_PER_SAMPLE;
const SILENCE_RMS_THRESHOLD = 0.001;

// model.int8.onnx full size is ~228MB; anything smaller means a truncated
// download (SmartSub's existence-only check was vulnerable to this).
const MIN_MODEL_ONNX_BYTES = 200 * 1024 * 1024;
const FUNASR_REQUIRED_FILES = ["model.int8.onnx", "tokens.txt"];

class FunasrServerManager {
  constructor() {
    this.wsServer = new FunasrWsServer();
  }

  getBinaryPath() {
    return this.wsServer.getWsBinaryPath();
  }

  isAvailable() {
    return this.wsServer.isAvailable();
  }

  getModelsDir() {
    return getModelsDirForService("funasr");
  }

  isModelDownloaded(modelName) {
    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!fs.existsSync(modelDir)) return false;

    for (const file of FUNASR_REQUIRED_FILES) {
      if (!fs.existsSync(path.join(modelDir, file))) {
        return false;
      }
    }

    try {
      const stats = fs.statSync(path.join(modelDir, "model.int8.onnx"));
      return stats.size >= MIN_MODEL_ONNX_BYTES;
    } catch {
      return false;
    }
  }

  async _ensureWav(audioBuffer, options = {}) {
    const { signal } = options;
    throwIfAborted(signal);

    const isWav = isWavFormat(audioBuffer);
    if (isWav) return { wavBuffer: audioBuffer, filesToCleanup: [] };

    const ffmpegPath = getFFmpegPath();
    if (!ffmpegPath) {
      throw new Error(
        "FFmpeg not found - required for audio conversion. Please ensure FFmpeg is installed."
      );
    }

    const tempDir = getSafeTempDir();
    const timestamp = Date.now();
    const tempInputPath = path.join(tempDir, `funasr-input-${timestamp}.webm`);
    const tempWavPath = path.join(tempDir, `funasr-${timestamp}.wav`);

    fs.writeFileSync(tempInputPath, audioBuffer);

    const inputStats = fs.statSync(tempInputPath);
    debugLogger.debug("Converting audio to WAV", { inputSize: inputStats.size });

    await convertToWav(tempInputPath, tempWavPath, { sampleRate: 16000, channels: 1, signal });

    const wavBuffer = fs.readFileSync(tempWavPath);
    return { wavBuffer, filesToCleanup: [tempInputPath, tempWavPath] };
  }

  async transcribe(audioBuffer, options = {}) {
    const { modelName = "sensevoice-small", language = "auto", useItn = true } = options;
    const { signal } = options;
    throwIfAborted(signal);

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      throw new Error(`FunASR model "${modelName}" not downloaded`);
    }

    debugLogger.debug("FunASR transcription request", {
      modelName,
      audioSize: audioBuffer?.length || 0,
      isWavFormat: isWavFormat(audioBuffer),
      language,
    });

    const { wavBuffer, filesToCleanup } = await this._ensureWav(audioBuffer, { signal });
    try {
      throwIfAborted(signal);
      if (
        !this.wsServer.ready ||
        this.wsServer.modelName !== modelName ||
        this.wsServer.language !== language ||
        this.wsServer.useItn !== (useItn !== false)
      ) {
        await this.wsServer.start(modelName, modelDir, { language, useItn });
      }
      throwIfAborted(signal);

      const samples = wavToFloat32Samples(wavBuffer);
      const durationSeconds = samples.length / BYTES_PER_SAMPLE / SAMPLE_RATE;

      const rms = computeFloat32RMS(samples);
      debugLogger.debug("FunASR audio analysis", { durationSeconds, rms });
      if (rms < SILENCE_RMS_THRESHOLD) {
        return { text: "", elapsed: 0 };
      }

      if (samples.length <= MAX_SEGMENT_BYTES) {
        const result = await this.wsServer.transcribe(samples, SAMPLE_RATE, { signal });
        if (!result.text?.trim()) {
          debugLogger.warn("FunASR returned empty text for non-silent audio", {
            durationSeconds,
            rms,
            samplesBytes: samples.length,
          });
        }
        return result;
      }

      debugLogger.debug("FunASR segmenting long audio", {
        durationSeconds,
        segmentCount: Math.ceil(samples.length / MAX_SEGMENT_BYTES),
      });

      const texts = [];
      let totalElapsed = 0;

      for (let offset = 0; offset < samples.length; offset += MAX_SEGMENT_BYTES) {
        throwIfAborted(signal);
        const end = Math.min(offset + MAX_SEGMENT_BYTES, samples.length);
        const segment = samples.subarray(offset, end);
        const result = await this.wsServer.transcribe(segment, SAMPLE_RATE, { signal });
        totalElapsed += result.elapsed || 0;
        if (result.text) {
          texts.push(result.text);
        } else {
          debugLogger.warn("FunASR segment returned empty text", {
            segmentIndex: offset / MAX_SEGMENT_BYTES,
            segmentDuration: segment.length / BYTES_PER_SAMPLE / SAMPLE_RATE,
          });
        }
      }

      return { text: joinSegmentTexts(texts), elapsed: totalElapsed };
    } finally {
      this._cleanupFiles(filesToCleanup);
    }
  }

  _cleanupFiles(filePaths) {
    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        debugLogger.warn("Failed to cleanup temp audio file", {
          path: filePath,
          error: err.message,
        });
      }
    }
  }

  async startServer(modelName, options = {}) {
    if (!this.wsServer.isAvailable()) {
      return { success: false, reason: "funasr WS server binary not found" };
    }

    const modelDir = path.join(this.getModelsDir(), modelName);
    if (!this.isModelDownloaded(modelName)) {
      return { success: false, reason: `Model "${modelName}" not downloaded` };
    }

    try {
      await this.wsServer.start(modelName, modelDir, options);
      return { success: true, port: this.wsServer.port };
    } catch (error) {
      debugLogger.error("Failed to start funasr WS server", { error: error.message });
      return { success: false, reason: error.message };
    }
  }

  async stopServer() {
    await this.wsServer.stop();
  }

  getServerStatus() {
    return this.wsServer.getStatus();
  }

  getStatus() {
    return {
      available: this.isAvailable(),
      binaryPath: this.getBinaryPath(),
      modelsDir: this.getModelsDir(),
    };
  }
}

// SenseVoice output has no spaces for zh/yue/ja; joining those segments with a
// space would inject spurious gaps, while Latin-script segments do need one.
function joinSegmentTexts(texts) {
  let joined = "";
  for (const text of texts) {
    if (!text) continue;
    if (!joined) {
      joined = text;
      continue;
    }
    const prevChar = joined[joined.length - 1];
    const needsSpace = !/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef。、，！？…]/.test(prevChar);
    joined += (needsSpace ? " " : "") + text;
  }
  return joined;
}

module.exports = FunasrServerManager;
module.exports.FUNASR_REQUIRED_FILES = FUNASR_REQUIRED_FILES;
module.exports.MIN_MODEL_ONNX_BYTES = MIN_MODEL_ONNX_BYTES;
