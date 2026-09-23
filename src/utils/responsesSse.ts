/**
 * SSE parser for the OpenAI-compatible Responses API stream (`stream: true`).
 *
 * Wire format (DeepSeek and OpenAI alike): events separated by blank lines,
 * each event carries an `event: <type>` line and one or more `data: <json>`
 * lines. The stream ends with `response.completed` / `response.incomplete` /
 * `response.failed` — there is no `data: [DONE]` sentinel.
 *
 * Dependency-free so the Node test runner can load it.
 */

export interface ResponsesSseEvent {
  /** `event:` field value, e.g. "response.output_text.delta". */
  type: string;
  /** Parsed `data:` JSON (raw string when the payload is not JSON). */
  data: unknown;
}

function parseEventBlock(block: string): ResponsesSseEvent | null {
  let type = "";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue; // comments / keep-alives
    if (line.startsWith("event:")) {
      type = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (!type && dataLines.length === 0) return null;
  const raw = dataLines.join("\n");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw);
  } catch {
    // Non-JSON payload (should not happen on this API) — keep the raw text.
  }
  return { type: type || "message", data };
}

export interface ResponsesSseParser {
  /** Feed a decoded text chunk; returns the events completed by it. */
  feed(chunk: string): ResponsesSseEvent[];
  /** Flush whatever remains after the stream closes (truncated tail event). */
  flush(): ResponsesSseEvent[];
}

export function createResponsesSseParser(): ResponsesSseParser {
  let buffer = "";

  const drain = (final: boolean): ResponsesSseEvent[] => {
    const events: ResponsesSseEvent[] = [];
    for (;;) {
      const boundary = /\r?\n\r?\n/.exec(buffer);
      if (!boundary) break;
      const event = parseEventBlock(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      if (event) events.push(event);
    }
    if (final && buffer.trim()) {
      const event = parseEventBlock(buffer);
      buffer = "";
      if (event) events.push(event);
    }
    return events;
  };

  return {
    feed(chunk) {
      buffer += chunk;
      return drain(false);
    },
    flush() {
      return drain(true);
    },
  };
}

export interface ResponsesStreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}

export type NormalizedResponsesEvent =
  | { kind: "reasoning-delta"; text: string }
  | { kind: "content-delta"; text: string }
  | { kind: "completed"; usage?: ResponsesStreamUsage; response?: unknown }
  | { kind: "incomplete"; reason?: string; usage?: ResponsesStreamUsage; response?: unknown }
  | { kind: "failed"; message: string }
  | { kind: "other" };

function readUsage(response: unknown): ResponsesStreamUsage | undefined {
  const usage = (response as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const details = (usage.output_tokens_details ?? {}) as Record<string, unknown>;
  const inputDetails = (usage.input_tokens_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: typeof usage.input_tokens === "number" ? usage.input_tokens : undefined,
    outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : undefined,
    reasoningTokens:
      typeof details.reasoning_tokens === "number" ? details.reasoning_tokens : undefined,
    cachedTokens:
      typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : undefined,
  };
}

/** Map one wire event onto the shape the streaming UI consumes. */
export function normalizeResponsesEvent(event: ResponsesSseEvent): NormalizedResponsesEvent {
  const data = event.data as Record<string, unknown> | null;
  switch (event.type) {
    case "response.reasoning_text.delta":
      return { kind: "reasoning-delta", text: String(data?.delta ?? "") };
    case "response.output_text.delta":
      return { kind: "content-delta", text: String(data?.delta ?? "") };
    case "response.completed": {
      const response = data?.response;
      return { kind: "completed", usage: readUsage(response), response };
    }
    case "response.incomplete": {
      const response = data?.response;
      const reason = (response as { incomplete_details?: { reason?: string } } | null)
        ?.incomplete_details?.reason;
      return { kind: "incomplete", reason, usage: readUsage(response), response };
    }
    case "response.failed": {
      const response = data?.response as { error?: { message?: string } } | null;
      return {
        kind: "failed",
        message: response?.error?.message || "The streaming response failed",
      };
    }
    default:
      return { kind: "other" };
  }
}
