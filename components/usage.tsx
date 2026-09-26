"use client";

import { useState } from "react";
import { Row, Sheet } from "./bits";
import type { ChatUsage } from "@/lib/chat/types";

export function formatTokens(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return String(Math.round(value));
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function formatCost(usd: number | undefined): string {
  if (usd === undefined) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * One strip of the numbers the transcript files actually record: tokens, cache reuse,
 * live context against the model's window, spend, and time.
 */
export function UsageBar({ usage, model }: { usage: ChatUsage | undefined; model: string | null }) {
  const [open, setOpen] = useState(false);
  if (!usage || (!usage.input_tokens && !usage.output_tokens && !usage.cost_usd)) return null;

  const context = usage.context_tokens;
  const max = usage.context_max;
  const percentage = context && max ? Math.min(100, Math.round((context / max) * 100)) : null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="tap flex w-full items-center gap-1.5 overflow-x-auto border-b border-ink-850 px-3 py-2 text-left text-xs whitespace-nowrap text-ink-400 no-scrollbar"
        title="Token, time and context usage"
      >
        <span className="text-ink-200">↑{formatTokens(usage.input_tokens)}</span>
        <span className="text-ink-200">↓{formatTokens(usage.output_tokens)}</span>
        {usage.cache_hit !== undefined ? <span>· {Math.round(usage.cache_hit * 100)}% cached</span> : null}
        {context ? (
          <span>
            · ctx {formatTokens(context)}
            {max ? `/${formatTokens(max)}` : ""}
          </span>
        ) : null}
        {usage.cost_usd !== undefined ? <span>· {formatCost(usage.cost_usd)}</span> : null}
        {usage.wall_ms !== undefined ? <span>· {formatDuration(usage.wall_ms)}</span> : null}
        <span className="ml-auto pl-2 text-ink-600">›</span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Usage">
        <div className="space-y-3">
          <div className="rounded-xl border border-ink-800 px-3">
            <Row label="model" value={model ?? "unknown"} />
            <Row label="input tokens" value={formatTokens(usage.input_tokens)} />
            <Row label="output tokens" value={formatTokens(usage.output_tokens)} />
            <Row label="reasoning tokens" value={formatTokens(usage.reasoning_tokens)} />
            <Row label="cache read" value={formatTokens(usage.cache_read_tokens)} />
            <Row label="cache write" value={formatTokens(usage.cache_write_tokens)} />
            <Row label="cache hit" value={usage.cache_hit !== undefined ? `${Math.round(usage.cache_hit * 100)}%` : "—"} />
            <Row label="cost" value={formatCost(usage.cost_usd)} />
          </div>

          <div className="rounded-xl border border-ink-800 px-3">
            <Row label="context used" value={context ? formatTokens(context) : "—"} />
            <Row label="context max" value={max ? `${formatTokens(max)}${usage.context_max_source === "family" ? " (est.)" : ""}` : "unknown for this model"} />
            <Row label="provider time" value={formatDuration(usage.api_ms)} />
            <Row label="time to first token" value={formatDuration(usage.ttft_ms)} />
            <Row label="tool time" value={formatDuration(usage.tool_ms)} />
            <Row label="wall clock" value={formatDuration(usage.wall_ms)} />
          </div>

          {percentage !== null ? (
            <div>
              <div className="mb-1 flex items-center justify-between text-[0.7rem] text-ink-400">
                <span>context window</span>
                <span>{percentage}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-ink-800">
                <div
                  className={`h-full ${percentage > 90 ? "bg-[var(--color-blocked)]" : percentage > 70 ? "bg-[var(--color-working)]" : "bg-[var(--color-done)]"}`}
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </div>
          ) : null}

          <p className="text-[0.7rem] text-ink-400">
            Read from the agent's own session file. Context is the prompt size of its latest turn; max comes from the
            models.dev registry (unknown models show no ceiling).
          </p>
        </div>
      </Sheet>
    </>
  );
}
