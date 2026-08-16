"use client";

import { LoaderCircle } from "lucide-react";
import type { ContextUsage } from "@/domain/consultation-journey";

interface ContextUsageRingProps {
  usage: ContextUsage | null;
  auto: boolean;
  busy: boolean;
  onCompact: () => void;
  onToggleAuto: () => void;
}

const R = 13; // ring radius (px)
const C = 2 * Math.PI * R; // circumference

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * CC-style context-usage ring. Shows how full the model's context window is
 * (contextTokens / contextWindow). Click the ring to compact the conversation
 * (fold older turns into a summary); the "自动" toggle compacts automatically
 * once usage crosses the threshold. Works offline — the usage is estimated
 * locally by the backend, and compaction has a deterministic offline summary.
 */
export function ContextUsageRing({
  usage,
  auto,
  busy,
  onCompact,
  onToggleAuto,
}: ContextUsageRingProps) {
  const ratio = usage ? Math.max(0, Math.min(1, usage.ratio)) : 0;
  const pct = Math.round(ratio * 100);
  const level = ratio >= 0.8 ? "high" : ratio >= 0.5 ? "mid" : "low";
  const dash = C * ratio;

  const title = usage
    ? `上下文已用 ${fmt(usage.contextTokens)} / ${fmt(usage.contextWindow)} tokens（${pct}%）· ${usage.model}` +
      (usage.compacted ? " · 已压缩" : "") +
      "\n点击圆环进行 compact（压缩早期对话为摘要）"
    : "上下文占用";

  return (
    <div className="context-ring-wrap" title={title}>
      <button
        className={`context-ring level-${level} ${usage?.compacted ? "compacted" : ""}`}
        onClick={onCompact}
        disabled={busy}
        aria-label={`上下文占用 ${pct}%，点击压缩`}
      >
        <svg viewBox="0 0 32 32" width="30" height="30">
          <circle className="ring-track" cx="16" cy="16" r={R} />
          <circle
            className="ring-value"
            cx="16"
            cy="16"
            r={R}
            strokeDasharray={`${dash} ${C - dash}`}
            transform="rotate(-90 16 16)"
          />
        </svg>
        <span className="context-ring-pct">
          {busy ? <LoaderCircle className="spin" size={11} /> : `${pct}%`}
        </span>
      </button>
      <button
        className={`context-auto ${auto ? "on" : ""}`}
        onClick={onToggleAuto}
        aria-pressed={auto}
        title="自动 compact：占用超过 80% 时自动压缩"
      >
        自动
      </button>
    </div>
  );
}
