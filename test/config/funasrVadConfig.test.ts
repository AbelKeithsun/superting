import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_FUNASR_VAD_CONFIG,
  FUNASR_VAD_LIMITS,
  clampFunasrVadField,
  sanitizeFunasrVadConfig,
} from "../../src/helpers/funasrVadConfig.js";

test("sanitize keeps defaults for empty input", () => {
  assert.deepEqual(sanitizeFunasrVadConfig(), {
    ...DEFAULT_FUNASR_VAD_CONFIG,
    enabled: false,
  });
});

test("sanitize coerces and clamps numeric fields", () => {
  const cfg = sanitizeFunasrVadConfig({
    enabled: true,
    threshold: 5,
    minSpeechDurationMs: "10",
    minSilenceDurationMs: 99999,
    maxSpeechDurationS: 0,
    speechPadMs: "abc",
  });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.threshold, 0.95);
  assert.equal(cfg.minSpeechDurationMs, 50);
  assert.equal(cfg.minSilenceDurationMs, 5000);
  assert.equal(cfg.maxSpeechDurationS, 1);
  assert.equal(cfg.speechPadMs, DEFAULT_FUNASR_VAD_CONFIG.speechPadMs);
});

test("sanitize treats only boolean true as enabled", () => {
  assert.equal(sanitizeFunasrVadConfig({ enabled: true }).enabled, true);
  assert.equal(sanitizeFunasrVadConfig({ enabled: "true" }).enabled, false);
  assert.equal(sanitizeFunasrVadConfig({ enabled: 1 }).enabled, false);
});

test("clampFunasrVadField respects per-key limits", () => {
  assert.equal(clampFunasrVadField("threshold", 0.05), FUNASR_VAD_LIMITS.threshold.min);
  assert.equal(clampFunasrVadField("minSilenceDurationMs", 100.4), 100);
  assert.equal(clampFunasrVadField("maxSpeechDurationS", 12), 12);
});
