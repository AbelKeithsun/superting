import type { ReasoningConfig } from "../services/BaseReasoningService";
import type { SettingsState } from "./settingsStore";
import {
  getSettings,
  selectIsCloudNoteFormattingMode,
  selectResolvedNoteFormatting,
} from "./settingsStore";

export interface NoteFormattingRequestOptions {
  settings?: SettingsState;
  /** Explicit model override; falls back to the resolved note-formatting model. */
  modelId?: string;
  systemPrompt: string;
  /**
   * Output budget for this call. Receives the resolved provider so the caller can
   * keep the per-provider ceiling policy in noteActionBudget.js.
   */
  maxTokensForProvider: (provider: string) => number;
  timeoutMs?: number;
  temperature?: number;
  /**
   * Override the scope's disable-thinking setting. Interactive features
   * (transcript polish) pass true: on reasoning models the low-effort hint is
   * the single biggest latency lever, and a proofreading pass does not need
   * deep thought. Providers that reject the hint retry without it.
   */
  disableThinking?: boolean;
  isCloudMode?: boolean;
  /**
   * When true (default) an empty/unparseable response throws instead of echoing
   * the input back — see ReasoningConfig.failOnEmptyResponse.
   */
  failOnEmptyResponse?: boolean;
}

export interface NoteFormattingRequest {
  selectedModel: string;
  reasoningConfig: ReasoningConfig;
  resolvedFormatting: ReturnType<typeof selectResolvedNoteFormatting>;
  isHostedMode: boolean;
  /**
   * False when neither a model nor a self-hosted URL was resolved. Callers own
   * the failure (the note actions log it with their operation id first).
   */
  hasModel: boolean;
}

/**
 * Resolve one note-formatting AI request (note actions, transcript polish).
 *
 * Shared by every feature that runs on the 笔记格式化 scope, so the provider
 * routing (self-hosted / providers / custom base + key) and the "no model"
 * failure mode stay in one place instead of drifting between callers.
 */
export function resolveNoteFormattingRequest({
  settings,
  modelId,
  systemPrompt,
  maxTokensForProvider,
  timeoutMs,
  temperature = 0.3,
  disableThinking,
  isCloudMode = false,
  failOnEmptyResponse = true,
}: NoteFormattingRequestOptions): NoteFormattingRequest {
  const current = settings ?? getSettings();
  const resolvedFormatting = selectResolvedNoteFormatting(current);
  const isHostedMode = isCloudMode || selectIsCloudNoteFormattingMode(current);
  const selectedModel = modelId || resolvedFormatting.model;

  const reasoningConfig: ReasoningConfig = {
    systemPrompt,
    temperature,
    disableThinking: disableThinking ?? current.noteFormattingDisableThinking,
    maxTokens: maxTokensForProvider(resolvedFormatting.provider),
    timeoutMs,
    failOnEmptyResponse,
  };

  if (isHostedMode) {
    throw new Error("Hosted note actions are not available in this build.");
  } else if (resolvedFormatting.mode === "self-hosted" && resolvedFormatting.remoteUrl) {
    reasoningConfig.lanUrl = resolvedFormatting.remoteUrl;
  } else if (resolvedFormatting.mode === "providers" || resolvedFormatting.mode === "enterprise") {
    reasoningConfig.provider = resolvedFormatting.provider || undefined;
  }

  if (resolvedFormatting.provider === "custom") {
    reasoningConfig.baseUrl = resolvedFormatting.cloudBaseUrl;
    reasoningConfig.customApiKey = current.noteFormattingCustomApiKey;
  }

  if (!selectedModel && !reasoningConfig.lanUrl) {
    return { selectedModel, reasoningConfig, resolvedFormatting, isHostedMode, hasModel: false };
  }

  return { selectedModel, reasoningConfig, resolvedFormatting, isHostedMode, hasModel: true };
}
