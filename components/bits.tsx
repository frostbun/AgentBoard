"use client";

import { useEffect, type ReactNode } from "react";
import type { AgentStatus } from "@/lib/herdr/types";

const STATUS_STYLE: Record<AgentStatus, { dot: string; text: string; label: string }> = {
  blocked: { dot: "bg-[var(--color-blocked)]", text: "text-[var(--color-blocked)]", label: "needs input" },
  done: { dot: "bg-[var(--color-done)]", text: "text-[var(--color-done)]", label: "done" },
  working: { dot: "bg-[var(--color-working)]", text: "text-[var(--color-working)]", label: "working" },
  idle: { dot: "bg-[var(--color-idle)]", text: "text-ink-400", label: "idle" },
  unknown: { dot: "bg-ink-600", text: "text-ink-400", label: "unknown" },
};

export function StatusDot({ status, size = 10 }: { status: AgentStatus; size?: number }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  return (
    <span
      className={`inline-block shrink-0 rounded-full ${style.dot} ${status === "working" ? "spinner-dot" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

export function StatusPill({ status }: { status: AgentStatus }) {
  const style = STATUS_STYLE[status] ?? STATUS_STYLE.unknown;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-ink-800 bg-ink-900 px-2 py-0.5 text-[0.7rem] font-medium ${style.text}`}
    >
      <StatusDot status={status} size={7} />
      {style.label}
    </span>
  );
}

/** Full-height shell: one pinned viewport, so the inner scroller actually scrolls
 *  instead of growing the document (auto-scroll depends on that). */
export function Screen({ children }: { children: ReactNode }) {
  return <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col overflow-hidden">{children}</div>;
}

export function TopBar({
  title,
  subtitle,
  badge,
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="pad-top sticky top-0 z-20 border-b border-ink-850 bg-ink-950/90 px-4 pb-2 backdrop-blur">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.05rem] font-semibold text-white">{title}</h1>
          {subtitle ? <div className="truncate text-xs text-ink-400">{subtitle}</div> : null}
        </div>
        {badge}
        {right}
      </div>
    </header>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  tone = "default",
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: "default" | "danger" | "accent";
  disabled?: boolean;
}) {
  const toneClass =
    tone === "danger"
      ? "border-[var(--color-blocked)]/40 text-[var(--color-blocked)]"
      : tone === "accent"
        ? "border-[var(--color-accent)]/50 text-[var(--color-accent)]"
        : "border-ink-700 text-ink-200";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={`tap inline-flex items-center justify-center gap-1.5 rounded-xl border bg-ink-900 px-3 text-sm ${toneClass} disabled:opacity-40 active:bg-ink-800`}
    >
      {children}
    </button>
  );
}

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={onClose} role="presentation">
      <div
        className="pad-bottom max-h-[80dvh] w-full scroll-y rounded-t-2xl border-t border-ink-800 bg-ink-900 p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">{title}</h2>
          <button type="button" onClick={onClose} className="rounded-lg px-2 py-1 text-sm text-ink-400">
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-850 py-2 last:border-0">
      <span className="shrink-0 text-xs uppercase tracking-wide text-ink-400">{label}</span>
      <span className="min-w-0 truncate text-right text-sm">{value}</span>
    </div>
  );
}

export function Button({
  children,
  onClick,
  tone = "default",
  full,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: "default" | "primary" | "danger";
  full?: boolean;
  disabled?: boolean;
}) {
  const toneClass =
    tone === "primary"
      ? "bg-[var(--color-accent)] text-ink-950 border-transparent font-semibold"
      : tone === "danger"
        ? "border-[var(--color-blocked)]/40 text-[var(--color-blocked)]"
        : "border-ink-700 text-ink-200";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`tap inline-flex items-center justify-center rounded-xl border bg-ink-900 px-3 text-sm ${toneClass} ${full ? "w-full" : ""} disabled:opacity-40 active:bg-ink-800`}
    >
      {children}
    </button>
  );
}
