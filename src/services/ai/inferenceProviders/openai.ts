import type { InferenceProvider } from "./types";
import { API_ENDPOINTS, TOKEN_LIMITS, buildApiUrl } from "../../../config/constants";
import { getOpenAiApiConfig } from "../../../models/ModelRegistry";
import { getSettings } from "../../../stores/settingsStore";
import { withRetry, createApiRetryStrategy, requestTimeoutError } from "../../../utils/retry";
import logger from "../../../utils/logger";
import { getConfiguredOpenAIBase } from "../openaiBase";
import { applyThinkingSuppression } from "../thinkingSuppression";
import { extractOpenAiResponseText } from "../openaiResponseText.js";
// CJS files get no interop under Vite 8 (rolldown) dev — import the ESM mirror.
import { formatOpenAiCompatibleError } from "../openaiCompatibleErrorsCompat";

const OPENAI_ENDPOINT_PREF_STORAGE_KEY = "openAiEndpointPreference";
const REQUEST_TIMEOUT_MS = 90_000;
const PROBE_TIMEOUT_MS = 2_000;

const endpointPreferenceCache = new Map<string, "responses" | "chat">();
const probedBases = new Set<string>();
// base|model keys whose server rejected the Responses-API `reasoning` field
// with a 400 — skip the field on subsequent calls.
const reasoningFieldUnsupported = new Set<string>();

function readStoredPreference(base: string): "responses" | "chat" | undefined {
  if (endpointPreferenceCache.has(base)) {
    return endpointPreferenceCache.get(base);
  }

  if (typeof window === "undefined" || !window.localStorage) {
    return undefined;
  }

  try {
    const raw = window.localStorage.getItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const value = parsed[base];
    if (value === "responses" || value === "chat") {
      endpointPreferenceCache.set(base, value);
      return value;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function rememberPreference(base: string, preference: "responses" | "chat"): void {
  endpointPreferenceCache.set(base, preference);

  if (typeof window === "undefined" || !window.localStorage) {
    return;
  }

  try {
    const raw = window.localStorage.getItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const data = typeof parsed === "object" && parsed !== null ? parsed : {};
    data[base] = preference;
    window.localStorage.setItem(OPENAI_ENDPOINT_PREF_STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

function getEndpointCandidates(base: string): Array<{ url: string; type: "responses" | "chat" }> {
  const lower = base.toLowerCase();

  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    const type: "responses" | "chat" = lower.endsWith("/responses") ? "responses" : "chat";
    return [{ url: base, type }];
  }

  const preference = readStoredPreference(base);
  if (preference === "chat") {
    return [{ url: buildApiUrl(base, "/chat/completions"), type: "chat" }];
  }

  return [
    { url: buildApiUrl(base, "/responses"), type: "responses" },
    { url: buildApiUrl(base, "/chat/completions"), type: "chat" },
  ];
}

/** Probe `/v1/models` to detect llama.cpp and prefer `/chat/completions`. */
async function detectServerType(base: string): Promise<void> {
  if (probedBases.has(base) || readStoredPreference(base) !== undefined) {
    return;
  }

  const lower = base.toLowerCase();
  if (lower.endsWith("/responses") || lower.endsWith("/chat/completions")) {
    return;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const res = await fetch(buildApiUrl(base, "/models"), {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      probedBases.add(base);
      return;
    }

    const body = await res.json();
    const first = body?.data?.[0];

    if (first?.owned_by === "llamacpp") {
      rememberPreference(base, "chat");
      logger.logReasoning("LLAMACPP_DETECTED_VIA_MODELS", {
        base,
        modelId: first?.id,
        ownedBy: first.owned_by,
      });
    }

    probedBases.add(base);
  } catch {
    probedBases.add(base);
  }
}

export const openaiProvider: InferenceProvider = {
  id: "openai",
  async call({ text, model, agentName, config, ctx }) {
    const resolvedProvider = config.provider || getSettings().cleanupProvider || "";
    const isCustomProvider = resolvedProvider === "custom";

    logger.logReasoning("OPENAI_START", {
      model,
      agentName,
      isCustomProvider,
    });

    const overrideKey = isCustomProvider ? config.customApiKey?.trim() : "";
    const apiKey = overrideKey || (await ctx.getApiKey(isCustomProvider ? "custom" : "openai"));

    logger.logReasoning("OPENAI_API_KEY", {
      hasApiKey: !!apiKey,
      keyLength: apiKey?.length || 0,
    });

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    const openAiBase = config.baseUrl?.trim() || getConfiguredOpenAIBase();
    // Note actions can legitimately generate tens of thousands of tokens (a
    // full transcript rewrite measured ~170s), so they raise the cap.
    const requestTimeoutMs = config.timeoutMs || REQUEST_TIMEOUT_MS;
    await detectServerType(openAiBase);
    const endpointCandidates = getEndpointCandidates(openAiBase);
    const isCustomEndpoint = openAiBase !== API_ENDPOINTS.OPENAI_BASE;

    logger.logReasoning("OPENAI_ENDPOINTS", {
      base: openAiBase,
      isCustomEndpoint,
      candidates: endpointCandidates.map((candidate) => candidate.url),
      preference: readStoredPreference(openAiBase) || null,
    });

    if (isCustomEndpoint) {
      logger.logReasoning("CUSTOM_TEXT_CLEANUP_REQUEST", {
        customBase: openAiBase,
        model,
        textLength: text.length,
        hasApiKey: !!apiKey,
        apiKeyPreview: apiKey ? `${apiKey.substring(0, 8)}...` : "(none)",
      });
    }

    const response = await withRetry(async () => {
      let lastError: Error | null = null;

      for (const { url: endpoint, type } of endpointCandidates) {
        // Responses API: reasoning models burn hidden thinking tokens before any
        // visible output. When thinking is disabled for the scope, ask for low
        // reasoning effort. Strict servers that reject the unknown `reasoning`
        // field with a 400 get one automatic retry without it (remembered).
        const reasoningCacheKey = `${openAiBase}|${model}`;
        for (const allowReasoningField of [true, false]) {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
          try {
            const maxTokens =
              config.maxTokens ||
              Math.max(
                4096,
                ctx.calculateMaxTokens(
                  text.length,
                  TOKEN_LIMITS.MIN_TOKENS,
                  TOKEN_LIMITS.MAX_TOKENS,
                  TOKEN_LIMITS.TOKEN_MULTIPLIER
                )
              );

            const apiConfig = getOpenAiApiConfig(model);
            const requestBody: Record<string, unknown> = { model };

            if (type === "responses") {
              requestBody.input = messages;
              requestBody.store = false;
              requestBody.max_output_tokens = maxTokens;
              if (
                allowReasoningField &&
                config.disableThinking === true &&
                !reasoningFieldUnsupported.has(reasoningCacheKey)
              ) {
                requestBody.reasoning = { effort: "low" };
              }
            } else {
              requestBody.messages = messages;
              requestBody[apiConfig.tokenParam] = maxTokens;
              applyThinkingSuppression(requestBody, model, resolvedProvider, config);
            }

            if (apiConfig.supportsTemperature) {
              requestBody.temperature = config.temperature || 0.3;
            }

            const res = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });

            if (!res.ok) {
              const errorData = await res.json().catch(() => ({ error: res.statusText }));
              const fallbackMessage =
                errorData.error?.message || errorData.message || `OpenAI API error: ${res.status}`;
              const errorMessage = formatOpenAiCompatibleError({
                status: res.status,
                fallbackMessage,
                isCustomProvider,
              });

              const reasoningFieldRejected =
                type === "responses" &&
                res.status === 400 &&
                requestBody.reasoning !== undefined &&
                /reasoning/i.test(errorMessage);

              if (reasoningFieldRejected && allowReasoningField) {
                reasoningFieldUnsupported.add(reasoningCacheKey);
                logger.logReasoning("OPENAI_REASONING_FIELD_UNSUPPORTED", {
                  attemptedEndpoint: endpoint,
                  error: errorMessage,
                });
                continue; // retry the same endpoint without the reasoning field
              }

              const isUnsupportedEndpoint =
                (res.status === 404 || res.status === 405) && type === "responses";

              if (isUnsupportedEndpoint) {
                lastError = new Error(errorMessage);
                rememberPreference(openAiBase, "chat");
                logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                  attemptedEndpoint: endpoint,
                  error: errorMessage,
                });
                break;
              }

              throw new Error(errorMessage);
            }

            rememberPreference(openAiBase, type);
            return res.json();
          } catch (error) {
            if ((error as Error).name === "AbortError") {
              throw requestTimeoutError(requestTimeoutMs);
            }
            lastError = error as Error;
            if (type === "responses") {
              logger.logReasoning("OPENAI_ENDPOINT_FALLBACK", {
                attemptedEndpoint: endpoint,
                error: (error as Error).message,
              });
              break;
            }
            throw error;
          } finally {
            clearTimeout(timeoutId);
          }
        }
      }

      throw lastError || new Error("No OpenAI endpoint responded");
    }, createApiRetryStrategy());

    const extraction = extractOpenAiResponseText(response);
    const isResponsesApi = extraction.isResponsesApi;
    const isChatCompletions = extraction.isChatCompletions;

    logger.logReasoning("OPENAI_RAW_RESPONSE", {
      model,
      format: isResponsesApi ? "responses" : isChatCompletions ? "chat_completions" : "unknown",
      hasOutput: isResponsesApi,
      outputLength: isResponsesApi ? response.output.length : 0,
      outputTypes: isResponsesApi
        ? response.output.map((item: { type: string }) => item.type)
        : undefined,
      hasChoices: isChatCompletions,
      choicesLength: isChatCompletions ? response.choices.length : 0,
      status: extraction.status,
      incompleteReason: extraction.incompleteReason,
      reasoningOnly: extraction.reasoningOnly,
      usage: response.usage,
    });

    const responseText = extraction.text;

    logger.logReasoning("OPENAI_RESPONSE", {
      model,
      responseLength: responseText.length,
      tokensUsed: response.usage?.total_tokens || 0,
      success: true,
      isEmpty: responseText.length === 0,
    });

    if (!responseText) {
      logger.logReasoning("OPENAI_EMPTY_RESPONSE_FALLBACK", {
        model,
        originalTextLength: text.length,
        reason: "Empty response from API",
        status: extraction.status,
        incompleteReason: extraction.incompleteReason,
        reasoningOnly: extraction.reasoningOnly,
        failOnEmptyResponse: config.failOnEmptyResponse === true,
      });

      if (config.failOnEmptyResponse) {
        // Never silently hand the caller its own input back as a "result" —
        // for note actions that meant overwriting the note with the raw
        // transcript. Surface a descriptive error instead.
        if (extraction.incompleteReason === "max_output_tokens" || extraction.reasoningOnly) {
          throw new Error(
            "The model spent its entire output budget on reasoning and returned no content. " +
              "Raise the output token budget or lower the reasoning effort, then run the action again."
          );
        }
        throw new Error(
          "The model returned an empty or unreadable response. Check the model and endpoint configuration, then try again."
        );
      }

      return text;
    }

    return responseText;
  },
};
