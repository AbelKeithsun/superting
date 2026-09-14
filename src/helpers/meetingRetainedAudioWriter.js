const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const VALID_SOURCES = new Set(["mic", "system"]);
const VALID_MIX_STRATEGIES = new Set(["stereo", "mix", "system-priority"]);
// Retention captures at 48 kHz so the archived file keeps the full speech
// band (the 24 kHz ASR path stays untouched); 24 kHz fallback chunks from the
// main-process dispatch path are resampled up to this rate on write.
const DEFAULT_SAMPLE_RATE = 48000;
const LEGACY_SAMPLE_RATE = 24000;
const DEFAULT_MIX_STRATEGY = "stereo";
const BYTES_PER_SAMPLE = 2;
const AUDIBLE_PEAK_THRESHOLD = 256;
// Below this peak the raw mic signal is too quiet for comfortable playback;
// normalize it up (compensates for the raw-mic capture path having no AGC).
const NORMALIZATION_TARGET_PEAK = 0.5;
const NORMALIZATION_MIN_PEAK = 0.25;
// Soft-knee limiter knee: pass-through below it, compress above it.
const LIMITER_KNEE = 0.85;

function clampInt16(value) {
  if (value > 32767) return 32767;
  if (value < -32768) return -32768;
  return value;
}

function calculatePeak(pcm) {
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += BYTES_PER_SAMPLE) {
    const abs = Math.abs(pcm.readInt16LE(offset));
    if (abs > peak) peak = abs;
  }
  return peak;
}

function softLimitSample(normalized) {
  const abs = Math.abs(normalized);
  if (abs <= LIMITER_KNEE) return normalized;
  const sign = normalized < 0 ? -1 : 1;
  const overshoot = (abs - LIMITER_KNEE) / (1 - LIMITER_KNEE);
  const compressed = LIMITER_KNEE + (1 - LIMITER_KNEE) * Math.tanh(overshoot);
  return sign * compressed;
}

function applyGainAndLimiter(pcm, gain) {
  // Cheap integer pre-scan: if neither gain nor the knee is reached, leave
  // the buffer untouched (finalize runs on the main process thread).
  let peak = 0;
  for (let offset = 0; offset + 1 < pcm.length; offset += BYTES_PER_SAMPLE) {
    const abs = Math.abs(pcm.readInt16LE(offset));
    if (abs > peak) peak = abs;
  }
  const needsGain = gain !== 1;
  const needsLimiter = peak / 32768 * gain > LIMITER_KNEE;
  if (!needsGain && !needsLimiter) return pcm;

  for (let offset = 0; offset + 1 < pcm.length; offset += BYTES_PER_SAMPLE) {
    const sample = (pcm.readInt16LE(offset) / 32768) * gain;
    pcm.writeInt16LE(clampInt16(Math.round(softLimitSample(sample) * 32767)), offset);
  }
  return pcm;
}

function resolveGainForPeak(peak) {
  if (peak <= 0) return 1;
  if (peak >= NORMALIZATION_MIN_PEAK) return 1;
  return Math.min(4, NORMALIZATION_TARGET_PEAK / peak);
}

function resamplePcm16(pcm, fromRate, toRate) {
  if (fromRate === toRate || !pcm?.length) return pcm;
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / BYTES_PER_SAMPLE);
  const ratio = toRate / fromRate;
  if (ratio === 1) return pcm;
  if (!Number.isFinite(ratio) || ratio <= 0) return pcm;

  if (ratio > 1 && Number.isInteger(ratio)) {
    // Integer upsampling (e.g. 24k -> 48k): sample duplication keeps the
    // waveform exact without inventing intermediate values.
    const output = new Int16Array(input.length * ratio);
    for (let i = 0; i < input.length; i++) {
      for (let copy = 0; copy < ratio; copy++) {
        output[i * ratio + copy] = input[i];
      }
    }
    return Buffer.from(output.buffer);
  }

  const outputLength = Math.floor(input.length * ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIdx = i / ratio;
    const idx = Math.floor(srcIdx);
    const frac = srcIdx - idx;
    const s0 = input[idx];
    const s1 = idx + 1 < input.length ? input[idx + 1] : s0;
    output[i] = Math.round(s0 + frac * (s1 - s0));
  }
  return Buffer.from(output.buffer);
}

function padPcmToStart(pcm, offsetMs, sampleRate, channels) {
  const frameCount = Math.max(0, Math.round((offsetMs / 1000) * sampleRate));
  if (frameCount === 0) return pcm;
  return Buffer.concat([Buffer.alloc(frameCount * channels * BYTES_PER_SAMPLE), pcm]);
}

function readSamples(pcm) {
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / BYTES_PER_SAMPLE);
  return samples;
}

function mixPcmBuffers(buffers) {
  const outputLength = Math.max(...buffers.map((buffer) => buffer.length));
  const output = Buffer.alloc(outputLength);
  for (let offset = 0; offset < outputLength; offset += BYTES_PER_SAMPLE) {
    let sum = 0;
    let count = 0;
    for (const buffer of buffers) {
      if (offset + 1 < buffer.length) {
        sum += buffer.readInt16LE(offset);
        count += 1;
      }
    }
    output.writeInt16LE(clampInt16(Math.round(sum / Math.max(1, count))), offset);
  }
  return output;
}

function sumPcmBuffers(buffers) {
  const outputLength = Math.max(...buffers.map((buffer) => buffer.length));
  const output = Buffer.alloc(outputLength);
  for (let offset = 0; offset < outputLength; offset += BYTES_PER_SAMPLE) {
    let sum = 0;
    for (const buffer of buffers) {
      if (offset + 1 < buffer.length) {
        sum += buffer.readInt16LE(offset);
      }
    }
    output.writeInt16LE(clampInt16(Math.round(sum)), offset);
  }
  return applyGainAndLimiter(output, 1);
}

// mic -> L channel, system -> R channel: keeps both sources independent so
// correlated content never cancels and dual-talk stays separable on playback.
function interleaveStereoPcm(leftPcm, rightPcm, sampleRate) {
  const left = readSamples(leftPcm);
  const right = readSamples(rightPcm);
  const frameCount = Math.max(left.length, right.length);
  const framesPerMs = sampleRate / 1000;
  const rightDelayFrames = Math.round(
    Math.max(0, ((rightPcm.__startOffsetMs || 0) - (leftPcm.__startOffsetMs || 0)) * framesPerMs)
  );
  const output = Buffer.alloc(frameCount * 2 * BYTES_PER_SAMPLE);
  for (let frame = 0; frame < frameCount; frame++) {
    const l = frame < left.length ? left[frame] : 0;
    const rIdx = frame - rightDelayFrames;
    const r = rIdx >= 0 && rIdx < right.length ? right[rIdx] : 0;
    output.writeInt16LE(l, frame * 2 * BYTES_PER_SAMPLE);
    output.writeInt16LE(r, frame * 2 * BYTES_PER_SAMPLE + BYTES_PER_SAMPLE);
  }
  return output;
}

class MeetingRetainedAudioWriter {
  constructor(options = {}) {
    this.tmpDir = options.tmpDir || os.tmpdir();
    this.sampleRate = options.sampleRate || DEFAULT_SAMPLE_RATE;
    this.mixStrategy = VALID_MIX_STRATEGIES.has(options.mixStrategy)
      ? options.mixStrategy
      : DEFAULT_MIX_STRATEGY;
    this.debugLogger = options.debugLogger || null;
    this.id = options.id || `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    this.startedAt = null;
    this.finalizedPath = null;
    this.sources = {
      mic: this.createSourceState("mic"),
      system: this.createSourceState("system"),
    };
  }

  createSourceState(source) {
    return {
      source,
      path: path.join(this.tmpDir, `superting-meeting-retained-${this.id}-${source}.pcm`),
      firstTimestampMs: null,
      bytesWritten: 0,
      peak: 0,
    };
  }

  writeChunk(source, chunk, timestampMs = Date.now(), inputSampleRate = this.sampleRate) {
    if (!VALID_SOURCES.has(source) || !chunk?.length) {
      return false;
    }

    const resampled = resamplePcm16(Buffer.from(chunk), inputSampleRate, this.sampleRate);
    const state = this.sources[source];
    if (state.firstTimestampMs == null) {
      state.firstTimestampMs = timestampMs;
    }
    this.startedAt = this.startedAt == null ? timestampMs : Math.min(this.startedAt, timestampMs);
    state.bytesWritten += resampled.length;
    state.peak = Math.max(state.peak, calculatePeak(resampled));
    fs.mkdirSync(this.tmpDir, { recursive: true });
    fs.appendFileSync(state.path, resampled);
    return true;
  }

  async finalize(options = {}) {
    const requireAudible = options.requireAudible === true;
    const mixStrategy = VALID_MIX_STRATEGIES.has(options.mixStrategy)
      ? options.mixStrategy
      : this.mixStrategy;
    const candidates = Object.values(this.sources)
      .filter((state) => state.bytesWritten > 0 && fs.existsSync(state.path))
      .map((state) => {
        const rawPcm = fs.readFileSync(state.path);
        const alignedPcm = padPcmToStart(
          rawPcm,
          Math.max(0, state.firstTimestampMs - this.startedAt),
          this.sampleRate,
          1
        );
        // Carried so the stereo interleaver can honor differing start times.
        alignedPcm.__startOffsetMs = state.firstTimestampMs - this.startedAt;
        return {
          source: state.source,
          pcm: alignedPcm,
          peak: state.peak,
          audible: state.peak > AUDIBLE_PEAK_THRESHOLD,
          bytesWritten: state.bytesWritten,
          firstTimestampMs: state.firstTimestampMs,
        };
      });

    if (candidates.length === 0) {
      return { success: false, error: "No meeting audio captured" };
    }

    const audibleCandidates = candidates.filter((candidate) => candidate.audible);
    if (audibleCandidates.length === 0 && requireAudible) {
      return {
        success: false,
        error: "No audible meeting audio captured",
        stats: this.buildStats(candidates),
      };
    }

    // Prefer audible sources; if nothing is audible keep the mic (or first
    // candidate) so a silent-but-present recording still round-trips.
    const selected =
      audibleCandidates.length > 0
        ? audibleCandidates
        : [candidates.find((c) => c.source === "mic") || candidates[0]];
    const effective = selected;

    let mixedPcm;
    let channels;
    let sourceMix;
    if (mixStrategy === "stereo" && effective.length === 2) {
      const micPcm = effective.find((c) => c.source === "mic")?.pcm;
      const systemPcm = effective.find((c) => c.source === "system")?.pcm;
      if (micPcm && systemPcm) {
        mixedPcm = interleaveStereoPcm(micPcm, systemPcm, this.sampleRate);
        channels = 2;
        sourceMix = "stereo";
      }
    }

    if (mixedPcm == null) {
      if (effective.length === 1) {
        mixedPcm = Buffer.from(effective[0].pcm);
        sourceMix = effective[0].source;
      } else if (mixStrategy === "system-priority") {
        // Sum instead of average: averaging correlated mic/system content
        // causes comb filtering and drops each source ~6 dB.
        mixedPcm = sumPcmBuffers(effective.map((c) => c.pcm));
        sourceMix = "system-priority";
      } else {
        mixedPcm = mixPcmBuffers(effective.map((c) => c.pcm));
        sourceMix = "mixed";
      }
      channels = 1;
    }

    // Shared gain from the loudest mono source keeps L/R imaging intact for
    // stereo output while still lifting quiet raw-mic recordings.
    const referencePeak = Math.max(...selected.map((c) => c.peak)) / 32768;
    const gain = resolveGainForPeak(referencePeak);
    applyGainAndLimiter(mixedPcm, gain);

    const outputPath = path.join(this.tmpDir, `superting-meeting-retained-${this.id}-mixed.pcm`);
    fs.writeFileSync(outputPath, mixedPcm);
    this.finalizedPath = outputPath;

    this.debugLogger?.debug?.("Meeting retained audio finalized", {
      sourceMix,
      sampleRate: this.sampleRate,
      channels,
      mixStrategy,
      gain: Number(gain.toFixed(2)),
      durationSeconds:
        mixedPcm.length / (this.sampleRate * channels * BYTES_PER_SAMPLE),
      stats: this.buildStats(candidates),
    });

    return {
      success: true,
      pcmPath: outputPath,
      startedAt: this.startedAt ? new Date(this.startedAt) : new Date(),
      durationSeconds: mixedPcm.length / (this.sampleRate * channels * BYTES_PER_SAMPLE),
      sourceMix,
      sampleRate: this.sampleRate,
      channels,
      stats: this.buildStats(candidates),
    };
  }

  buildStats(candidates) {
    const stats = {};
    for (const candidate of candidates) {
      stats[candidate.source] = {
        bytesWritten: candidate.bytesWritten,
        peak: candidate.peak,
        audible: candidate.audible,
        firstTimestampMs: candidate.firstTimestampMs,
      };
    }
    return stats;
  }

  async cleanup() {
    const paths = Object.values(this.sources).map((state) => state.path);
    if (this.finalizedPath) {
      paths.push(this.finalizedPath);
    }
    for (const filePath of paths) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Best-effort temp cleanup.
      }
    }
  }
}

module.exports = MeetingRetainedAudioWriter;
module.exports.RESAMPLE_PCM16 = resamplePcm16;
module.exports.DEFAULT_SAMPLE_RATE = DEFAULT_SAMPLE_RATE;
module.exports.LEGACY_SAMPLE_RATE = LEGACY_SAMPLE_RATE;
