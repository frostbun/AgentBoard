"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMsg, ChatQuestion, ChatSession, ChatToolBlock, PendingQuestion } from "@/lib/chat/types";
import { Button } from "./bits";
import { activeSession, callAction, useAutoGrow, useTypeMirror, withSession } from "./use-board";

/* ------------------------------------------------------------------ text -- */

const FENCE = /```([^\n]*)\n([\s\S]*?)(?:```|$)/g;

function inlineNodes(text: string, key: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|https?:\/\/[^\s)<>]+)/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) {
      nodes.push(<code key={`${key}-c${index}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={`${key}-b${index}`}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <a key={`${key}-a${index}`} href={token} target="_blank" rel="noreferrer">
          {token.replace(/^https?:\/\//, "")}
        </a>,
      );
    }
    last = pattern.lastIndex;
    index += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function proseNodes(text: string, key: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((item, index) => <li key={`${key}-li${index}`}>{inlineNodes(item, `${key}-li${index}`)}</li>);
    blocks.push(list.ordered ? <ol key={`${key}-ol${blocks.length}`}>{items}</ol> : <ul key={`${key}-ul${blocks.length}`}>{items}</ul>);
    list = null;
  };

  for (const line of lines) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flush();
      continue;
    }
    if (heading) {
      flush();
      blocks.push(<h3 key={`${key}-h${blocks.length}`}>{inlineNodes(heading[2], `${key}-h${blocks.length}`)}</h3>);
      continue;
    }
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }
    flush();
    blocks.push(<p key={`${key}-p${blocks.length}`}>{inlineNodes(line, `${key}-p${blocks.length}`)}</p>);
  }
  flush();
  return blocks;
}

export function RichText({ text }: { text: string }) {
  const nodes = useMemo(() => {
    const out: ReactNode[] = [];
    let last = 0;
    let index = 0;
    let match: RegExpExecArray | null;
    FENCE.lastIndex = 0;
    while ((match = FENCE.exec(text))) {
      const before = text.slice(last, match.index);
      if (before.trim()) out.push(<div key={`p${index}`}>{proseNodes(before, `p${index}`)}</div>);
      out.push(
        <pre key={`f${index}`}>
          <code>{match[2]}</code>
        </pre>,
      );
      last = FENCE.lastIndex;
      index += 1;
    }
    const tail = text.slice(last);
    if (tail.trim()) out.push(<div key={`p${index}`}>{proseNodes(tail, `p${index}`)}</div>);
    return out;
  }, [text]);
  return <div className="prose-chat text-[0.9rem] leading-relaxed">{nodes}</div>;
}

/* ------------------------------------------------------------------ tools -- */

function toolSummary(block: ChatToolBlock): string {
  const args = block.args;
  if (args && typeof args === "object") {
    const rec = args as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"]) {
      const value = rec[key];
      if (typeof value === "string" && value.trim()) return value.split("\n")[0].slice(0, 160);
    }
    const first = Object.values(rec).find((value) => typeof value === "string");
    if (typeof first === "string" && first.trim()) return first.split("\n")[0].slice(0, 160);
    return JSON.stringify(rec).slice(0, 160);
  }
  return String(args ?? "");
}

function ToolState({ state }: { state: ChatToolBlock["state"] }) {
  const glyph = state === "running" ? "●" : state === "error" ? "✕" : "✓";
  const tone =
    state === "running"
      ? "text-[var(--color-working)]"
      : state === "error"
        ? "text-[var(--color-blocked)]"
        : "text-[var(--color-done)]";
  return <span className={`${tone} text-[0.7rem] ${state === "running" ? "spinner-dot" : ""}`}>{glyph}</span>;
}

export function ToolCard({ block }: { block: ChatToolBlock }) {
  const [open, setOpen] = useState(false);
  const result = block.result ?? "";
  const args = typeof block.args === "string" ? block.args : JSON.stringify(block.args, null, 2);
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ToolState state={block.state} />
        <span className="font-mono text-[0.72rem] text-ink-200">{block.name}</span>
        <span className="min-w-0 flex-1 truncate text-[0.72rem] text-ink-400">{toolSummary(block)}</span>
        <span className="text-[0.65rem] text-ink-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-ink-850 px-3 py-2">
          {args && args !== "{}" ? (
            <pre className="scroll-y max-h-52 rounded-lg bg-ink-950 p-2 text-[0.7rem] text-ink-200">{args}</pre>
          ) : null}
          {result ? (
            <pre className="scroll-y max-h-72 rounded-lg bg-ink-950 p-2 text-[0.7rem] whitespace-pre-wrap text-ink-200">{result}</pre>
          ) : (
            <div className="text-[0.7rem] text-ink-400">no output yet</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* --------------------------------------------------------------- messages -- */

function Message({ message }: { message: ChatMsg }) {
  if (message.role === "note") {
    return (
      <div className="my-2 text-center text-[0.7rem] text-ink-400">
        {message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(" ")}
      </div>
    );
  }
  const mine = message.role === "user";
  return (
    <div className={`my-2 flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[92%] ${mine ? "rounded-2xl rounded-br-md bg-[var(--color-accent)]/15 px-3 py-2" : "w-full"}`}>
        {message.blocks.map((block, index) => {
          if (block.kind === "tool") return <ToolCard key={`${message.id}-${index}`} block={block} />;
          if (block.kind === "thinking") {
            return (
              <details key={`${message.id}-${index}`} className="my-1 text-[0.75rem] text-ink-400">
                <summary className="cursor-pointer select-none">thinking</summary>
                <div className="prose-chat mt-1 border-l-2 border-ink-800 pl-2 italic">{block.text}</div>
              </details>
            );
          }
          if (block.kind === "error") {
            return (
              <div key={`${message.id}-${index}`} className="my-1 rounded-lg border border-[var(--color-blocked)]/40 px-2 py-1 text-[0.8rem] text-[var(--color-blocked)]">
                {block.text}
              </div>
            );
          }
          return <RichText key={`${message.id}-${index}`} text={block.text} />;
        })}
      </div>
    </div>
  );
}

export function MessageList({ session }: { session: ChatSession }) {
  if (!session.messages.length) {
    return (
      <div className="p-6 text-center text-sm text-ink-400">
        {session.awaitingFirstMessage
          ? "No messages yet — this agent has not taken its first turn. Prompt it below."
          : session.error
            ? session.error
            : "No transcript yet — prompt the agent or open the Terminal tab."}
      </div>
    );
  }
  return (
    <div className="px-3 pb-2">
      {session.truncated ? <div className="py-2 text-center text-[0.7rem] text-ink-400">earlier messages trimmed</div> : null}
      {session.messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- questions -- */

/** Box-drawing and whitespace are noise when matching screen text to a question. */
function flatten(text: string): string {
  return text
    .replace(/[\u2500-\u257F|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The dialog shows one question at a time; its text on screen identifies which. */
function activeQuestionIndex(screen: string, questions: ChatQuestion[]): number | null {
  const flat = flatten(screen);
  for (const [index, question] of questions.entries()) {
    const needle = flatten(question.question).slice(0, 32);
    if (needle.length >= 8 && flat.includes(needle)) return index;
  }
  return null;
}

export function QuestionCard({
  paneId,
  pending,
  session,
}: {
  paneId: string;
  pending: PendingQuestion;
  session?: string;
}) {
  const [stage, setStage] = useState(pending.index);
  const question = pending.questions[stage];
  const [custom, setCustom] = useState("");
  const [toggled, setToggled] = useState<number[]>([]);
  const [cursor, setCursor] = useState(0);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [screen, setScreen] = useState<string | null>(null);
  /** Multi-question asks end on a review screen that needs its own Enter. */
  const [reviewing, setReviewing] = useState(false);
  const preview = useRef<HTMLPreElement | null>(null);
  const typeMirror = useTypeMirror(paneId, session);
  const customRef = useAutoGrow(custom, 120);

  // Refs keep `refreshScreen` identity-stable: unstable deps here used to re-run the
  // stage effect on every render and blow up React with "Maximum update depth exceeded".
  const questionsRef = useRef(pending.questions);
  questionsRef.current = pending.questions;
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const forgetRef = useRef(typeMirror.forget);
  forgetRef.current = typeMirror.forget;

  // The dialog's "Other (type your own)" row sits after the declared options.
  const otherRow = question?.options.length ?? 0;

  /** The TUI cursor starts at row 0 and only moves when we move it: `space` toggles
   *  in place, so every action has to be expressed as a delta from the tracked row. */
  const keysTo = (target: number, action: string[]): string[] => {
    const delta = target - cursor;
    const moves = Array.from({ length: Math.abs(delta) }, () => (delta > 0 ? "down" : "up"));
    return [...moves, ...action];
  };

  const describe = (keys: string[]): string =>
    keys.map((key) => ({ down: "↓", up: "↑", space: "␣", enter: "⏎", backspace: "⌫" })[key] ?? key).join(" ");

  const refreshScreen = useCallback(async () => {
    try {
      const response = await fetch(`/api/pane-text?pane=${encodeURIComponent(paneId)}&lines=24&source=visible`, { cache: "no-store" });
      const payload = (await response.json()) as { text?: string };
      const text = payload.text ?? "";
      const lines = text.split("\n").filter((line) => line.trim().length > 0);
      setScreen(lines.slice(-9).join("\n"));
      setReviewing(/review answers/i.test(text));
      const detected = activeQuestionIndex(text, questionsRef.current);
      if (detected !== null && detected !== stageRef.current) {
        // The dialog advanced to the next question: fresh list, cursor on row 0.
        setStage(detected);
        setCursor(0);
        setToggled([]);
        forgetRef.current();
        setCustom("");
      }
    } catch {
      /* preview is best-effort */
    }
  }, [paneId, session]);

  useEffect(() => {
    setStage(pending.index);
    setCursor(0);
    setToggled([]);
    setSent(null);
    void refreshScreen();
    const timer = setInterval(() => {
      if (!document.hidden) void refreshScreen();
    }, 1200);
    return () => clearInterval(timer);
  }, [pending.tool_id, pending.index, refreshScreen]);

  useEffect(() => {
    const node = preview.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [screen]);

  if (!question) return null;

  const send = async (keys: string[], label: string) => {
    setError(null);
    try {
      await callAction("pane.send_keys", { pane_id: paneId, keys }, 30_000, session);
      setSent(`sent ${describe(keys)} — ${label}`);
      await refreshScreen();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const pick = (index: number) => {
    const keys = keysTo(index, ["enter"]);
    setCursor(0);
    return send(keys, question.options[index]?.label ?? "");
  };

  const toggle = (index: number) => {
    setToggled((current) => (current.includes(index) ? current.filter((item) => item !== index) : [...current, index]));
    setCursor(index);
    return send(keysTo(index, ["space"]), question.options[index]?.label ?? "");
  };

  /** An empty selection makes the TUI cancel the whole question, so Submit is gated. */
  const submit = () => {
    setCursor(0);
    setToggled([]);
    return send(["enter"], stage + 1 < pending.questions.length ? "next question" : "submit");
  };

  /** Typing lands on the "Other" row, so the cursor is parked there before the first key. */
  const typeCustom = (value: string) => {
    setCustom(value);
    const moves = keysTo(otherRow, []);
    if (moves.length) {
      setCursor(otherRow);
      void callAction("pane.send_keys", { pane_id: paneId, keys: moves }, 30_000, session);
    }
    typeMirror.mirror(value);
  };

  const sendCustom = async () => {
    setError(null);
    try {
      const typed = typeMirror.last() === custom.trim();
      if (!typed) {
        const moves = keysTo(otherRow, []);
        if (moves.length) await callAction("pane.send_keys", { pane_id: paneId, keys: moves }, 30_000, session);
        await callAction("pane.send_text", { pane_id: paneId, text: custom }, 30_000, session);
      }
      await callAction("pane.send_keys", { pane_id: paneId, keys: ["enter"] }, 30_000, session);
      setSent(typed ? `sent ⏎ “${custom}” (already mirrored)` : `sent “${custom}” ⏎`);
      setCursor(0);
      setToggled([]);
      typeMirror.forget();
      setCustom("");
      await refreshScreen();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="border-t border-[var(--color-blocked)]/30 bg-[var(--color-blocked)]/5 px-3 py-3">
      <div className="mb-1 flex items-center gap-2 text-[0.7rem] font-semibold tracking-wide text-[var(--color-blocked)] uppercase">
        <span className="spinner-dot">●</span> agent is asking
        {pending.questions.length > 1 ? (
          <span className="text-ink-400 normal-case">
            {reviewing ? "review" : `question ${stage + 1} of ${pending.questions.length}`}
          </span>
        ) : null}
      </div>
      <div className="prose-chat text-[0.9rem] text-white">{question.question}</div>

      <div className={`mt-2 space-y-1.5 ${reviewing ? "hidden" : ""}`}>
        {question.multi
          ? question.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => void toggle(index)}
                className={`tap w-full rounded-xl border px-3 py-2 text-left text-sm ${
                  toggled.includes(index) ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15" : "border-ink-700 bg-ink-900"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${toggled.includes(index) ? "text-[var(--color-accent)]" : "text-ink-400"}`}>
                    {toggled.includes(index) ? "◼" : "◻"}
                  </span>
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <span className={`font-mono text-[0.6rem] ${cursor === index ? "text-[var(--color-accent)]" : "text-ink-400"}`}>
                    {describe(keysTo(index, ["␣"]))}
                  </span>
                </div>
                {option.description ? <div className="mt-0.5 pl-5 text-[0.75rem] text-ink-400">{option.description}</div> : null}
              </button>
            ))
          : question.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => void pick(index)}
                className="tap w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-left text-sm active:bg-ink-800"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <span className="font-mono text-[0.6rem] text-ink-400">{describe(keysTo(index, ["⏎"]))}</span>
                </div>
                {option.description ? <div className="mt-0.5 text-[0.75rem] text-ink-400">{option.description}</div> : null}
              </button>
            ))}
      </div>

      {reviewing ? (
        <Button tone="primary" full onClick={() => void send(["enter"], "submit answers")}>
          Submit answers (⏎)
        </Button>
      ) : question.multi ? (
        <Button tone="primary" full disabled={toggled.length === 0} onClick={() => void submit()}>
          {toggled.length === 0
            ? "Toggle something first"
            : pending.questions.length === 1
              ? `Submit ${toggled.length} selection${toggled.length > 1 ? "s" : ""} (⏎)`
              : stage + 1 < pending.questions.length
                ? `Next question — ${toggled.length} selected (⏎)`
                : `Review answers — ${toggled.length} selected (⏎)`}
        </Button>
      ) : null}

      <div className={`mt-2 items-end gap-2 ${reviewing ? "hidden" : "flex"}`}>
        <textarea
          ref={customRef}
          value={custom}
          onChange={(event) => typeCustom(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendCustom();
            }
          }}
          rows={1}
          placeholder="Or type an answer…"
          className="scroll-y max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm"
        />
        <Button onClick={() => void sendCustom()} disabled={!custom.trim()}>
          Send
        </Button>
      </div>

      {sent ? <div className="mt-2 text-[0.7rem] text-ink-400">{sent}</div> : null}
      {error ? <div className="mt-2 text-[0.7rem] text-[var(--color-blocked)]">{error}</div> : null}
      {screen ? (
        <details className="mt-2 text-[0.7rem] text-ink-400" open>
          <summary className="cursor-pointer select-none">terminal dialog</summary>
          <pre ref={preview} className="scroll-y mt-1 max-h-40 rounded-lg bg-ink-950 p-2 text-[0.65rem] whitespace-pre text-ink-200">
            {screen}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- composer -- */

export function Composer({
  paneId,
  session,
  hasAgent = true,
  blocked = false,
  running = false,
  showKeys = true,
  placeholder = "Message this agent…",
}: {
  paneId: string;
  session?: string;
  hasAgent?: boolean;
  /** A question dialog owns the input line while blocked, so syncing pauses. */
  blocked?: boolean;
  /** The agent is mid-turn: only then can it be stopped. */
  running?: boolean;
  /** The raw key row belongs to the Terminal tab. */
  showKeys?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const typeMirror = useTypeMirror(paneId, session);
  const draftRef = useAutoGrow(draft, 160);
  const draftState = useRef({ value: draft, editedAt: 0 });
  draftState.current.value = draft;

  // herdr may own the input too: read its line and adopt it unless the board is mid-edit.
  useEffect(() => {
    if (!hasAgent || blocked) return;
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const response = await fetch(withSession(`/api/input-line?pane=${encodeURIComponent(paneId)}`, session), { cache: "no-store" });
        const payload = (await response.json()) as { text?: string | null };
        if (!alive || payload.text === null || payload.text === undefined) return;
        const known = typeMirror.last();
        if (payload.text === known) return;
        const focused = document.activeElement === draftRef.current;
        const dirty = draftState.current.value !== known && Date.now() - draftState.current.editedAt < 2000;
        if (focused && dirty) return; // the user is typing here; don't fight them
        typeMirror.adopt(payload.text);
        setDraft(payload.text);
      } catch {
        /* best effort */
      }
    };
    const timer = setInterval(() => void poll(), 1300);
    void poll();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [paneId, session, hasAgent, blocked, typeMirror, draftRef]);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (typeMirror.last() === text) {
        // The agent's input line already holds this text, verbatim.
        await callAction(
          hasAgent ? "agent.send_keys" : "pane.send_keys",
          hasAgent ? { target: paneId, keys: ["enter"] } : { pane_id: paneId, keys: ["enter"] },
          30_000,
          session,
        );
        setSent("sent ⏎ — text was already mirrored into the pane");
      } else {
        const response = await fetch("/api/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pane: paneId, text, session: session ?? activeSession() }),
        });
        const payload = (await response.json()) as { warning?: string; error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (payload.warning) setError(payload.warning);
        setSent(null);
      }
      typeMirror.forget();
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const key = async (keys: string[]) => {
    setError(null);
    try {
      // No agent in the pane means a plain shell: its keys go through the pane surface.
      if (hasAgent) await callAction("agent.send_keys", { target: paneId, keys }, 30_000, session);
      else await callAction("pane.send_keys", { pane_id: paneId, keys }, 30_000, session);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="pad-bottom border-t border-ink-850 bg-ink-950 px-3 pt-2">
      {error ? <div className="pb-1 text-[0.7rem] text-[var(--color-blocked)]">{error}</div> : null}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => void key(hasAgent ? ["esc"] : ["ctrl+c"])}
          disabled={!running}
          title={running ? "Stop this turn (Esc)" : "Nothing to stop — the agent is not working"}
          className="tap inline-flex shrink-0 items-center gap-1 rounded-2xl border border-[var(--color-blocked)]/40 px-3 text-sm text-[var(--color-blocked)] disabled:border-ink-800 disabled:text-ink-600"
        >
          ■
        </button>
        <textarea
          ref={draftRef}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            draftState.current.editedAt = Date.now();
            typeMirror.mirror(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={hasAgent ? placeholder : "Run in this shell…"}
          className="scroll-y max-h-40 min-h-11 flex-1 resize-none rounded-2xl border border-ink-700 bg-ink-900 px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !draft.trim()}
          className="tap inline-flex items-center rounded-2xl bg-[var(--color-accent)] px-4 text-sm font-semibold text-ink-950 disabled:opacity-40"
        >
          {busy ? "…" : "Send"}
        </button>
      </div>
      {sent || error ? (
        <div className={`pt-1 text-[0.65rem] ${error ? "text-[var(--color-blocked)]" : "text-ink-400"}`}>{error ?? sent}</div>
      ) : null}
      <div className={`mt-2 gap-2 overflow-x-auto no-scrollbar pb-1 ${showKeys ? "flex" : "hidden"}`}>
        <button type="button" onClick={() => void key(["esc"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          esc
        </button>
        <button type="button" onClick={() => void key(["ctrl+c"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          ctrl+c
        </button>
        <button type="button" onClick={() => void key(["enter"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          enter
        </button>
        <button type="button" onClick={() => void key(["up"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          ↑
        </button>
        <button type="button" onClick={() => void key(["down"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          ↓
        </button>
        <button type="button" onClick={() => void key(["left"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          ←
        </button>
        <button type="button" onClick={() => void key(["right"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          →
        </button>
        <button type="button" onClick={() => void key(["tab"])} className="shrink-0 rounded-lg border border-ink-700 px-2 py-1 text-[0.7rem] text-ink-400">
          tab
        </button>
      </div>
    </div>
  );
}
