"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
  // Portalled: a `backdrop-filter`/`transform` ancestor (the chat header's blur, for one) would
  // otherwise become the containing block for `fixed`, and the sheet would open off-screen.
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-end bg-black/60" onClick={onClose} role="presentation">
      <div
        className="pad-bottom max-h-[80dvh] w-full scroll-y rounded-t-2xl border-t border-ink-800 bg-ink-900 p-4"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            Close
          </IconButton>
        </div>
        {children}
      </div>
    </div>,
    document.body,
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

export type Tone = "default" | "primary" | "danger" | "accent";

/** Text buttons come in `sm` (compact actions) and `md` (anything standing on its own). */
export type Size = "sm" | "md";
/** Glyph buttons add `xs` for the ones that ride along a row, and are square at every size. */
export type IconSize = "xs" | Size;

const SIZES: Record<Size, string> = {
  sm: "min-h-10 px-3 text-sm",
  md: "min-h-11 px-4 text-[0.95rem]",
};

const ICON_SIZES: Record<IconSize, string> = {
  xs: "min-h-8 min-w-8 px-1.5 text-sm",
  sm: "min-h-10 min-w-10 px-2.5 text-sm",
  md: "min-h-11 min-w-11 px-3 text-[0.95rem]",
};

const TONES: Record<Tone, string> = {
  default: "border-ink-700 bg-ink-900 text-ink-200",
  primary: "border-transparent bg-[var(--color-accent)] font-semibold text-ink-950",
  danger: "border-[var(--color-blocked)]/40 bg-ink-900 text-[var(--color-blocked)]",
  accent: "border-[var(--color-accent)]/50 bg-[var(--color-accent)]/15 text-[var(--color-accent)]",
};

// No background in the base: `bg-ink-900` alongside a tone's `bg-*` is two utilities of equal
// specificity, and which one wins depends on their order in the generated stylesheet.
const BASE = "tap inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl border text-center disabled:opacity-40 active:bg-ink-800";

/** Text-button chrome. Exported via `Button`; only glyph buttons and links need the raw class. */
function buttonClass({ tone = "default", size = "md", full = false }: { tone?: Tone; size?: Size; full?: boolean } = {}): string {
  return `${BASE} ${SIZES[size]} ${TONES[tone]} ${full ? "w-full" : ""}`;
}

/** The same chrome as `IconButton`, for the `+` links that sit next to one. */
export function iconClass({ tone = "default", size = "xs" }: { tone?: Tone; size?: IconSize } = {}): string {
  return `${BASE} ${ICON_SIZES[size]} ${TONES[tone]}`;
}

export function Button({
  children,
  onClick,
  tone = "default",
  size = "md",
  full,
  disabled,
  label,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: Tone;
  size?: Size;
  full?: boolean;
  disabled?: boolean;
  /** Accessible name when the visible content is a glyph. */
  label?: string;
  /** Tooltip when the visible text is not the whole story. */
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={buttonClass({ tone, size, full })}
      aria-label={label}
      title={title ?? label}
    >
      {children}
    </button>
  );
}

/** Square button for a single glyph; `xs` is the row-riding default. */
export function IconButton({
  label,
  onClick,
  children,
  tone = "default",
  size = "xs",
  disabled,
}: {
  label: string;
  onClick?: () => void;
  children: ReactNode;
  tone?: Tone;
  size?: IconSize;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={iconClass({ tone, size })}
    >
      {children}
    </button>
  );
}
