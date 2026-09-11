/**
 * FunASR/SenseVoice language mapping (pure functions).
 *
 * Ported from SmartSub `main/helpers/engines/funasrParams.ts`
 * (MIT, Copyright (c) 2024 Lin Xiaodong).
 *
 * Maps superting's `preferredLanguage` to sherpa-onnx's
 * `--sense-voice-language` value (auto|zh|yue|en|ja|ko).
 *
 * Note: SmartSub's addon layer normalized 'auto' to an empty string;
 * the ws-server is CLI-driven, so the literal "auto" is passed instead.
 */

const SENSEVOICE_LANGUAGES = ["auto", "zh", "en", "ja", "ko", "yue"];

function resolveFunasrLanguage(preferredLanguage) {
  if (!preferredLanguage || preferredLanguage === "auto") return "auto";
  const normalized = String(preferredLanguage).toLowerCase();
  if (normalized.startsWith("yue") || normalized === "zh-hk" || normalized === "zh-yue") {
    return "yue";
  }
  if (normalized.startsWith("zh")) return "zh";
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("ja")) return "ja";
  if (normalized.startsWith("ko")) return "ko";
  return "auto";
}

module.exports = { resolveFunasrLanguage, SENSEVOICE_LANGUAGES };
