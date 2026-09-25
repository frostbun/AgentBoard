"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentStatus, AttentionItem, BoardState } from "@/lib/herdr/types";

/* --------------------------------------------------------------- sessions -- */

const SESSION_KEY = "agentboard.session";

/**
 * Last session this device looked at, used only as a fallback when a page has no explicit
 * session (a shared link, the spawn form before it loads). There is no board-wide filter:
 * the fleet always shows every session, and the server resolves panes across them.
 */
export function activeSession(): string {
  const store = globalThis as typeof globalThis & { __agentboard_session__?: string };
  if (store.__agentboard_session__ !== undefined) return store.__agentboard_session__;
  try {
    store.__agentboard_session__ = localStorage.getItem(SESSION_KEY) ?? "";
  } catch {
    store.__agentboard_session__ = "";
  }
  return store.__agentboard_session__;
}

export function rememberSession(sessionId: string): void {
  (globalThis as typeof globalThis & { __agentboard_session__?: string }).__agentboard_session__ = sessionId;
  try {
    localStorage.setItem(SESSION_KEY, sessionId);
  } catch {
    /* private mode */
  }
}

export function withSession(url: string, session?: string): string {
  const target = session ?? activeSession();
  if (!target) return url;
  return `${url}${url.includes("?") ? "&" : "?"}session=${encodeURIComponent(target)}`;
}

/* ---------------------------------------------------------------- actions -- */

export async function callAction<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
  session?: string,
): Promise<T> {
  const response = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params, timeout_ms: timeoutMs, session: session ?? activeSession() }),
  });
  const payload = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload.result as T;
}

/* ------------------------------------------------------------------ board -- */

export type SessionSnapshot = { id: string; label: string; alive: boolean; state: BoardState };

/** Every herdr session at once, for the federated fleet view. */
export function useAllSessions(): { sessions: SessionSnapshot[]; ready: boolean } {
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const source = new EventSource("/api/stream?scope=all");
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as { sessions?: SessionSnapshot[] };
        if (payload.sessions) {
          setSessions(payload.sessions);
          setReady(true);
        }
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, []);
  return { sessions, ready };
}

/**
 * Live board state for one session; null until the first frame. `null` as the argument
 * means "not resolved yet" and deliberately streams nothing.
 */
export function useBoard(sessionOverride?: string | null): BoardState | null {
  const session = sessionOverride === undefined ? activeSession() : sessionOverride;
  const [state, setState] = useState<BoardState | null>(null);
  useEffect(() => {
    setState(null);
    if (session === null) return;
    const source = new EventSource(`/api/stream${session ? `?session=${encodeURIComponent(session)}` : ""}`);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        setState(JSON.parse(event.data) as BoardState);
      } catch {
        /* ignore malformed frame */
      }
    };
    return () => source.close();
  }, [session]);
  return session === null ? null : state;
}

/* ----------------------------------------------------------------- alerts -- */

const MUTED_KEY = "agentboard.muted";

export function useAlertSettings(): { muted: boolean; toggle: () => void; ready: boolean } {
  const [muted, setMuted] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setMuted(localStorage.getItem(MUTED_KEY) === "1");
    setReady(true);
  }, []);
  const toggle = () => {
    setMuted((current) => {
      localStorage.setItem(MUTED_KEY, current ? "0" : "1");
      return !current;
    });
  };
  return { muted, toggle, ready };
}

function beep(): void {
  try {
    // Safari advertises only the prefixed constructor; the extra field is not in lib.dom.
    const legacy = window as Window & { webkitAudioContext?: typeof AudioContext };
    const Ctx = window.AudioContext ?? legacy.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [index, frequency] of [880, 1180].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = frequency;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.0001, now + index * 0.16);
      gain.gain.exponentialRampToValueAtTime(0.12, now + index * 0.16 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.16 + 0.14);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + index * 0.16);
      osc.stop(now + index * 0.16 + 0.15);
    }
    setTimeout(() => void ctx.close(), 800);
  } catch {
    /* audio is best-effort */
  }
}

const LABEL: Record<AgentStatus, string> = {
  blocked: "needs input",
  done: "finished",
  working: "working",
  idle: "idle",
  unknown: "unknown",
};

/** Sound + system notification the first time a pane enters blocked/done. */
export function useAttentionAlerts(attention: AttentionItem[] | null, muted: boolean): void {
  const announced = useRef(new Set<string>());
  const primed = useRef(false);

  useEffect(() => {
    if (!attention) return;
    const fresh: AttentionItem[] = [];
    for (const item of attention) {
      const key = `${item.pane_id}:${item.status}:${item.first_seen}`;
      if (announced.current.has(key)) continue;
      announced.current.add(key);
      fresh.push(item);
    }
    if (!primed.current) {
      primed.current = true; // first snapshot is history, not news
      return;
    }
    if (muted || !fresh.length) return;

    beep();
    for (const item of fresh.slice(0, 3)) {
      sendNotification(`${item.agent ?? "agent"}: ${LABEL[item.status]}`, item.title ?? item.cwd ?? item.pane_id, item.pane_id);
    }
  }, [attention, muted]);
}

/* ---------------------------------------------------------- notifications -- */

export type NotificationState = "unsupported" | "default" | "granted" | "denied";

export function notificationState(): NotificationState {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission as NotificationState;
}

/** Must be called from a user gesture — iOS ignores (and permanently denies) it otherwise. */
export async function requestNotificationPermission(): Promise<NotificationState> {
  if (typeof Notification === "undefined") return "unsupported";
  try {
    return (await Notification.requestPermission()) as NotificationState;
  } catch {
    return "denied";
  }
}

export function sendNotification(title: string, body?: string, tag?: string): boolean {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    new Notification(title, { body, tag, icon: "/icon.svg" });
    return true;
  } catch {
    return false;
  }
}

/** iOS only delivers web notifications to an installed web app, never a plain tab. */
export function notificationHint(state: NotificationState): string | null {
  if (state === "granted") return null;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (ios) return "On iOS, notifications need AgentBoard added to your Home Screen (Share → Add to Home Screen), then reopened from there.";
  if (state === "denied") return "Blocked in browser settings — re-allow notifications for this site, then reload.";
  if (state === "unsupported") return "This browser has no Notification API; sound and the in-app inbox still work.";
  return "Permission not requested yet.";
}

/* ----------------------------------------------------------------- format -- */

export function timeAgo(iso: string | number | null | undefined): string {
  if (iso === null || iso === undefined) return "";
  const ms = typeof iso === "number" ? iso : Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function shortCwd(cwd: string | null | undefined): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.length <= 2 ? cwd : `…/${parts.slice(-2).join("/")}`;
}

/* ------------------------------------------------------------------ input -- */

/** Textarea that grows with its content up to `maxPx`, then scrolls internally. */
export function useAutoGrow(value: string, maxPx: number): RefObject<HTMLTextAreaElement | null> {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, maxPx)}px`;
    node.style.overflowY = node.scrollHeight > maxPx ? "auto" : "hidden";
  }, [value, maxPx]);
  return ref;
}

/**
 * Mirrors what you type into the agent's own input line as you type it, so the pane
 * shows the same text before anything is submitted. Diffs against what was already
 * sent: appended characters are sent as text, deletions as backspaces.
 */
export function useTypeMirror(
  paneId: string,
  session?: string,
): {
  mirror: (text: string) => void;
  forget: () => void;
  last: () => string;
  /** Adopt text that appeared in the terminal without the board sending it. */
  adopt: (text: string) => void;
} {
  const sent = useRef("");
  const queued = useRef<string | null>(null);
  const timer = useRef<NodeJS.Timeout | number | null>(null);

  const flush = useCallback(async () => {
    const next = queued.current;
    queued.current = null;
    if (next === null || next === sent.current) return;
    const previous = sent.current;
    let common = 0;
    while (common < next.length && common < previous.length && next[common] === previous[common]) common += 1;
    const removals = previous.length - common;
    const appended = next.slice(common);
    try {
      if (removals > 0) {
        await callAction("pane.send_keys", { pane_id: paneId, keys: Array.from({ length: removals }, () => "backspace") }, 30_000, session);
      }
      if (appended) await callAction("pane.send_text", { pane_id: paneId, text: appended }, 30_000, session);
      sent.current = next;
    } catch {
      /* best effort: the submit path still reports real failures */
    }
  }, [paneId, session]);

  const mirror = useCallback(
    (text: string) => {
      queued.current = text;
      clearTimeout(timer.current ?? undefined);
      timer.current = setTimeout(() => void flush(), 180);
    },
    [flush],
  );

  const forget = useCallback(() => {
    sent.current = "";
    queued.current = null;
  }, []);

  const last = useCallback(() => sent.current, []);

  const adopt = useCallback((text: string) => {
    queued.current = null;
    sent.current = text;
  }, []);

  return useMemo(() => ({ mirror, forget, last, adopt }), [mirror, forget, last, adopt]);
}
