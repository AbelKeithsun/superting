const { DEFAULTS, LIMITS } = require("../constants/funasrVad.json");

const DEFAULT_FUNASR_VAD_CONFIG = Object.freeze({ ...DEFAULTS, enabled: false });
const FUNASR_VAD_LIMITS = Object.freeze(LIMITS);

function clampFunasrVadField(key, value) {
  const fallback = DEFAULTS[key];
  const n = value === null || value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  const { min, max, round } = LIMITS[key];
  const clamped = Math.min(max, Math.max(min, n));
  return round ? Math.round(clamped) : clamped;
}

function sanitizeFunasrVadConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input || {}) };
  const out = { enabled: merged.enabled === true };
  for (const key of Object.keys(DEFAULTS)) {
    out[key] = clampFunasrVadField(key, merged[key]);
  }
  return out;
}

module.exports = {
  DEFAULT_FUNASR_VAD_CONFIG,
  FUNASR_VAD_LIMITS,
  clampFunasrVadField,
  sanitizeFunasrVadConfig,
};
