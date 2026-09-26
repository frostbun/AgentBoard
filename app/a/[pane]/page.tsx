"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentNav } from "@/components/agent-nav";
import { Button, ConfirmSheet, IconButton, iconClass, PromptSheet, Row, Screen, Sheet, StatusPill } from "@/components/bits";
import { Composer, MessageList, ModelChip, QuestionCard } from "@/components/chat";
import { UsageBar } from "@/components/usage";
import { activeSession, callAction, shortCwd, useBoard, withSession } from "@/components/use-board";
import { resumeCommand } from "@/lib/herdr/names";
import type { ChatSession } from "@/lib/chat/types";
import type { BoardPane } from "@/lib/herdr/types";
import { closeWarning, paneTitle } from "@/lib/herdr/types";

/** Fallback only: transcript updates arrive pushed, this catches missed ones. */
const TRANSCRIPT_FALLBACK_MS = 10_000;
const PANE_POLL_MS = 1000;

export default function ChatPage() {
  const params = useParams<{ pane: string }>();
  const paneId = decodeURIComponent(params.pane);

  // Page-scoped session: the link says which session this pane belongs to, and that must
  // not overwrite the fleet's filter (otherwise "back" lands on a single-session board).
  const [pageSession, setPageSession] = useState<string | null>(null);
  useEffect(() => {
    const urlSession = new URLSearchParams(window.location.search).get("session");
    setPageSession(urlSession ?? activeSession() ?? "");
  }, []);
  const state = useBoard(pageSession);
  const pane: BoardPane | undefined = state?.panes.find((candidate) => candidate.pane_id === paneId);

  const [session, setSession] = useState<ChatSession | null>(null);
  const sessionSignature = useRef("");
  const [view, setView] = useState<"chat" | "terminal">("chat");
  const [paneText, setPaneText] = useState<string>("");
  const [controls, setControls] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  /** null closed, otherwise the draft pane title. */
  const [renameTitle, setRenameTitle] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const loadTranscript = useCallback(async () => {
    try {
      const response = await fetch(
        withSession(`/api/transcript?pane=${encodeURIComponent(paneId)}&limit=300`, pageSession ?? undefined),
        { cache: "no-store" },
      );
      if (!response.ok) {
        throw new Error(`transcript ${response.status} — this pane is not in session ${pageSession || "(default)"}`);
      }
      const payload = (await response.json()) as ChatSession & { session?: string };
      // The server resolves panes across sessions; follow its answer so later calls are right.
      if (payload.session && payload.session !== pageSession) setPageSession(payload.session);

      // Re-rendering a long transcript on every poll is what makes scrolling stutter, so a
      // payload that says nothing new keeps the previous object (and React's memoisation).
      const last = payload.messages[payload.messages.length - 1];
      const signature = [
        payload.messages.length,
        last?.id ?? "",
        last?.blocks.reduce((total, block) => total + ("text" in block ? block.text.length : 0), 0) ?? 0,
        payload.pending ? "pending" : "-",
        payload.usage?.context_tokens ?? "",
        payload.error ?? "",
        payload.awaitingFirstMessage ? "awaiting" : "-",
      ].join(":");
      if (signature !== sessionSignature.current) {
        sessionSignature.current = signature;
        setSession(payload);
      }
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [paneId, pageSession]);

  useEffect(() => {
    if (pageSession === null) return;
    void loadTranscript();
    const fallback = setInterval(() => {
      if (!document.hidden) void loadTranscript();
    }, TRANSCRIPT_FALLBACK_MS);
    // Instant path: the server watches the agent's session file and ticks on change.
    const tail = new EventSource(withSession(`/api/tail?pane=${encodeURIComponent(paneId)}`, pageSession ?? undefined));
    tail.onmessage = () => void loadTranscript();
    return () => {
      clearInterval(fallback);
      tail.close();
    };
  }, [loadTranscript, paneId, pageSession]);

  const pending = session?.pending ?? null;

  useEffect(() => {
    if (session?.pending) void loadTranscript();
  }, [session?.pending, loadTranscript]);

  useEffect(() => {
    if (view !== "terminal") return;
    let alive = true;
    const load = async () => {
      try {
        const response = await fetch(withSession(`/api/pane-text?pane=${encodeURIComponent(paneId)}&lines=500`, pageSession ?? undefined), { cache: "no-store" });
        const payload = (await response.json()) as { text?: string; error?: string };
        if (alive) setPaneText(payload.text ?? payload.error ?? "");
      } catch {
        /* transient */
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, PANE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [view, paneId, pageSession]);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    // Wait for the new text to be laid out before jumping to the bottom.
    const frame = requestAnimationFrame(() => {
      node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [session, paneText, view]);

  // Escape stops the current turn, the same thing the ■ button does. Skipped while a sheet is
  // open, so Escape can still close it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || controls || !pane?.agent || pane.agent_status !== "working") return;
      void callAction("agent.send_keys", { target: paneId, keys: ["esc"] }, 20_000, pageSession ?? undefined).catch(() => undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [controls, pane?.agent, pane?.agent_status, paneId, pageSession]);

  const onScroll = () => {
    const node = scroller.current;
    if (!node) return;
    stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
  };

  const run = async (label: string, work: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await work();
      setNotice(label);
      setTimeout(() => setNotice(null), 2500);
      void loadTranscript();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const agentLabel = pane?.display_agent ?? pane?.agent ?? "pane";
  // Resume needs herdr's own session reference; without one the chat says so instead of guessing.
  const resume = resumeCommand(pane?.agent, pane?.agent_session);

  const copy = (value: string) =>
    run("copied", async () => {
      await navigator.clipboard.writeText(value);
    });

  /** Closes on herdr's answer alone: the notice must never claim a pane that is still there. */
  const closePane = () =>
    run("pane closed", async () => {
      await callAction("pane.close", { pane_id: paneId }, 20_000, pageSession ?? undefined);
      setControls(false);
    });

  /** The ask is our sheet, not `window.prompt`: an installed iOS web app answers that with null. */
  const submitRename = async () => {
    const title = renameTitle?.trim();
    if (!title) {
      setRenameTitle(null);
      return;
    }
    await run("renamed", () => callAction("pane.rename", { pane_id: paneId, label: title }, 20_000, pageSession ?? undefined));
    // The notice and the error banner both sit under these sheets, so get out of their way.
    setRenameTitle(null);
    setControls(false);
  };

  return (
    <Screen>
      <header className="pad-top sticky top-0 z-20 border-b border-ink-850 bg-ink-950/90 px-3 pb-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <Link href="/" className={`${iconClass()} text-lg`} aria-label="Back to the board">
            ←
          </Link>
          <AgentNav paneId={paneId} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-white">{agentLabel}</span>
              {pane ? <StatusPill status={pane.agent_status} /> : null}
            </div>
            <div className="truncate text-[0.7rem] text-ink-400">
              {pane ? `${pane.workspace_label} / ${pane.tab_label} · ${shortCwd(pane.foreground_cwd ?? pane.cwd)}` : paneId}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <IconButton label="Pane controls" onClick={() => setControls(true)}>
              ⋯
            </IconButton>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="flex flex-1 gap-1 rounded-xl border border-ink-800 p-0.5 text-sm">
            {(["chat", "terminal"] as const).map((name) => (
              <button
                key={name}
                type="button"
                onClick={() => setView(name)}
                className={`tap min-h-9 flex-1 rounded-lg capitalize ${view === name ? "bg-ink-800 text-white" : "text-ink-400"}`}
              >
                {name}
              </button>
            ))}
          </div>
          <ModelChip paneId={paneId} session={pageSession ?? undefined} agent={pane?.agent} model={session?.model ?? null} />
        </div>
      </header>

      {error ? <div className="mx-3 mt-2 rounded-lg border border-[var(--color-blocked)]/40 px-3 py-2 text-xs text-[var(--color-blocked)]">{error}</div> : null}
      {notice ? <div className="mx-3 mt-2 rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-xs text-ink-200">{notice}</div> : null}

      {view === "chat" ? <UsageBar usage={session?.usage} model={session?.model ?? null} /> : null}

      <div ref={scroller} onScroll={onScroll} className="scroll-y min-h-0 flex-1">
        {view === "chat" ? (
          session ? (
            <MessageList session={session} running={pane?.agent_status === "working"} />
          ) : (
            <div className="p-6 text-center text-sm text-ink-400">loading transcript…</div>
          )
        ) : (
          <pre className="p-3 text-[0.68rem] leading-relaxed whitespace-pre-wrap text-ink-200">{paneText || "reading pane…"}</pre>
        )}
      </div>

      {session?.pending ? <QuestionCard paneId={paneId} pending={session.pending} session={pageSession ?? undefined} /> : null}

      <Composer
        paneId={paneId}
        session={pageSession ?? undefined}
        hasAgent={Boolean(pane?.agent)}
        blocked={pane?.agent_status === "blocked"}
        running={pane?.agent_status === "working"}
        showKeys={view === "terminal"}
      />

      <Sheet open={controls && !confirmClose} onClose={() => setControls(false)} title={agentLabel}>
        <div className="space-y-3">
          {pane ? (
            <div className="rounded-xl border border-ink-800 px-3">
              <Row label="herdr session" value={pageSession || state?.session || "—"} />
              <Row label="pane" value={pane.pane_id} />
              <Row label="status" value={pane.agent_status} />
              <Row label="title" value={paneTitle(pane) ?? "—"} />
              <Row label="cwd" value={pane.foreground_cwd ?? pane.cwd ?? "—"} />
              <Row label="session" value={pane.agent_session?.value ?? "—"} />
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => void run("focused in herdr", () => callAction("agent.focus", { target: paneId }))}>Focus in herdr</Button>
            <Button onClick={() => void run("zoom toggled", () => callAction("pane.zoom", { pane_id: paneId, mode: "toggle" }))}>Zoom pane</Button>
            <Button onClick={() => setRenameTitle(pane?.title ?? "")}>Rename</Button>
            <Button onClick={() => void run("interrupted", () => callAction("agent.send_keys", { target: paneId, keys: ["ctrl+c"] }))}>
              Interrupt
            </Button>
            <Button onClick={() => void run("enter sent", () => callAction("agent.send_keys", { target: paneId, keys: ["enter"] }))}>Send Enter</Button>
            <Button onClick={() => void run("escape sent", () => callAction("agent.send_keys", { target: paneId, keys: ["esc"] }))}>Send Esc</Button>
          </div>

          {resume ? (
            <div className="rounded-xl border border-ink-800 p-3">
              <div className="mb-1 text-xs uppercase tracking-wide text-ink-400">Resume locally</div>
              <code className="block truncate font-mono text-sm text-ink-200">{resume}</code>
              <div className="mt-2">
                <Button full onClick={() => void copy(resume)}>
                  Copy resume command
                </Button>
              </div>
            </div>
          ) : null}

          {pane?.agent_session ? (
            <Button full onClick={() => void copy(pane.agent_session!.value)}>
              Copy session reference
            </Button>
          ) : null}

          <Button
            full
            tone="danger"
            onClick={() => {
              // An ask we own, not window.confirm: an installed iOS web app answers that with
              // false and no dialog, and the notice below would claim a close that never ran.
              if (closeWarning(pane?.agent_status ?? "unknown")) setConfirmClose(true);
              else void closePane();
            }}
          >
            Close pane
          </Button>
        </div>
      </Sheet>

      <ConfirmSheet
        open={confirmClose}
        title={`Close ${paneId}`}
        body={`It ${closeWarning(pane?.agent_status ?? "unknown")}, and closing kills the agent.`}
        confirmLabel="Close pane"
        onConfirm={() => {
          setConfirmClose(false);
          void closePane();
        }}
        onClose={() => setConfirmClose(false)}
      />

      <PromptSheet
        open={renameTitle !== null}
        title={`Rename ${paneId}`}
        field="Pane title"
        value={renameTitle ?? ""}
        placeholder="what this pane is for"
        submitLabel="Rename"
        onChange={setRenameTitle}
        onSubmit={() => void submitRename()}
        onClose={() => setRenameTitle(null)}
      />
    </Screen>
  );
}
