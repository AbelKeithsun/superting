import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "../lib/utils";

interface ThinkingStreamProps {
  text: string;
  /** "reasoning" = 思考过程, "content" = 输出 */
  kind: "reasoning" | "content";
  expandedDefault?: boolean;
  streaming?: boolean;
}

/**
 * Collapsible live stream view (thinking chain or raw output). Auto-scrolls to
 * the tail while streaming unless the user scrolled up.
 */
export default function ThinkingStream({
  text,
  kind,
  expandedDefault = false,
  streaming = false,
}: ThinkingStreamProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(expandedDefault);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [text, expanded]);

  const label = t(
    kind === "reasoning" ? "notes.aiDrawer.thinking" : "notes.aiDrawer.contentOutput"
  );

  return (
    <div className="rounded-md border border-border/50 bg-muted/30">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {label}
        {streaming && (
          <span className="ml-auto inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
        )}
      </button>
      {expanded && (
        <div
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          }}
          className={cn(
            "max-h-48 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2 text-[11px] leading-5",
            kind === "reasoning" ? "text-muted-foreground" : "text-foreground/90"
          )}
        >
          {text || "…"}
        </div>
      )}
    </div>
  );
}
