import { getCleanupSystemPrompt } from "../config/prompts";
import { getSettings } from "../stores/settingsStore";

export interface ReasoningTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

/**
 * Live progress of one streaming request, delivered via ReasoningConfig.onStream.
 * `attempt-start` fires at each (re)try so consumers can reset their
 * accumulators; `completed` / `incomplete` carry the exact token usage.
 */
export type ReasoningStreamEvent =
  | { type: "attempt-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "content-delta"; text: string }
  | { type: "completed"; usage?: ReasoningTokenUsage }
  | { type: "incomplete"; reason?: string; usage?: ReasoningTokenUsage }
  | { type: "failed"; message: string };

export interface ReasoningConfig {
  maxTokens?: number;
  temperature?: number;
  contextSize?: number;
  systemPrompt?: string;
  lanUrl?: string;
  baseUrl?: string;
  customApiKey?: string;
  provider?: string;
  disableThinking?: boolean;
  /**
   * When set (and the provider/endpoint supports it — currently the OpenAI
   * Responses API), the request streams and this callback receives reasoning
   * deltas, content deltas and the final token usage. Providers without
   * streaming simply never call it.
   */
  onStream?: (event: ReasoningStreamEvent) => void;
  /**
   * When true, an empty/unparseable model response throws a descriptive
   * error instead of silently returning the input text. Note actions set
   * this — passing the input through would overwrite the note with its own
   * raw content. Dictation cleanup keeps the passthrough default.
   */
  failOnEmptyResponse?: boolean;
  /**
   * Wall-clock cap for a single provider request, in milliseconds. Defaults to
   * each provider's own timeout (90s). Note actions raise it: a full transcript
   * rewrite on a reasoning model has to emit the visible answer *and* the
   * hidden thinking tokens, which measured ~170s for a 59k-character input.
   */
  timeoutMs?: number;
}

export abstract class BaseReasoningService {
  protected isProcessing = false;

  protected getCustomDictionary(): string[] {
    return getSettings().customDictionary;
  }

  protected getPreferredLanguage(): string {
    return getSettings().preferredLanguage || "auto";
  }

  protected getUiLanguage(): string {
    return getSettings().uiLanguage || "en";
  }

  protected getSystemPrompt(agentName: string | null): string {
    return getCleanupSystemPrompt(
      agentName,
      this.getCustomDictionary(),
      this.getPreferredLanguage(),
      this.getUiLanguage()
    );
  }

  protected calculateMaxTokens(
    textLength: number,
    minTokens = 100,
    maxTokens = 2048,
    multiplier = 2
  ): number {
    return Math.max(minTokens, Math.min(textLength * multiplier, maxTokens));
  }

  abstract isAvailable(): Promise<boolean>;

  abstract processText(
    text: string,
    modelId: string,
    agentName?: string | null,
    config?: ReasoningConfig
  ): Promise<string>;
}
