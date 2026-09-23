import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiChunkState } from "../../stores/noteAiOperationStore";

/** chars → tokens estimate, measured on deepseek-flash (~0.6 tok/char). */
const TOKENS_PER_CHAR = 0.6;

function estimateTokens(chars: number): number {
  return Math.max(0, Math.round(chars * TOKENS_PER_CHAR));
}

function formatCount(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

interface StreamStatsBarProps {
  chunk: AiChunkState;
}

/**
 * Live token/speed readout for one streaming chunk. Before the terminal usage
 * arrives, output/thinking are char-based estimates (marked ~); afterwards the
 * exact Responses-API usage replaces them.
 */
export default function StreamStatsBar({ chunk }: StreamStatsBarProps) {
  const { t } = useTranslation();
  const running = chunk.phase === "streaming";
  const [, setTick] = useState(0);

  // 500ms heartbeat to refresh tok/s and elapsed while streaming.
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 500);
    return () => window.clearInterval(timer);
  }, [running]);

  const now = Date.now();
  const elapsedSeconds =
    chunk.startedAt != null ? Math.max(0, ((chunk.finishedAt ?? now) - chunk.startedAt) / 1000) : 0;

  const exact = chunk.usage;
  const reasoningTokens = exact?.reasoningTokens ?? estimateTokens(chunk.reasoningChars);
  const contentTokens =
    exact?.outputTokens != null
      ? Math.max(0, exact.outputTokens - (exact.reasoningTokens ?? 0))
      : estimateTokens(chunk.contentChars);
  const estimated = !exact;

  const streamSeconds =
    chunk.firstTokenAt != null
      ? Math.max(0.5, ((chunk.finishedAt ?? now) - chunk.firstTokenAt) / 1000)
      : 0;
  const speed =
    streamSeconds > 0 ? Math.round((reasoningTokens + contentTokens) / streamSeconds) : 0;

  const parts: string[] = [];
  if (exact?.inputTokens != null) {
    parts.push(`${t("notes.aiDrawer.statsInput")} ${formatCount(exact.inputTokens)}`);
  }
  parts.push(
    `${t("notes.aiDrawer.statsReasoning")} ${estimated ? "~" : ""}${formatCount(reasoningTokens)}`
  );
  parts.push(
    `${t("notes.aiDrawer.statsOutput")} ${estimated ? "~" : ""}${formatCount(contentTokens)}`
  );
  if (speed > 0) parts.push(t("notes.aiDrawer.statsSpeed", { speed }));
  if (chunk.startedAt != null) {
    parts.push(t("notes.aiDrawer.statsElapsed", { seconds: elapsedSeconds.toFixed(1) }));
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] tabular-nums text-muted-foreground/80">
      {parts.map((part, index) => (
        <span key={index}>{part}</span>
      ))}
    </div>
  );
}
