"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatMsg, ChatQuestion, ChatSession, ChatToolBlock, PendingQuestion, PlanProposal } from "@/lib/chat/types";
import { Button, IconButton, Row, Sheet } from "./bits";
import { formatDuration } from "./usage";
import { modelCommand, supportsModel } from "@/lib/herdr/names";
import { activeSession, callAction, useAutoGrow, useTypeMirror } from "./use-board";

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

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Splits a table row into cells, ignoring the outer pipes. */
function cellsOf(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function Table({ rows, header, tableKey }: { rows: string[][]; header: string[]; tableKey: string }) {
  return (
    <div className="scroll-y my-2 max-w-full overflow-x-auto rounded-lg border border-ink-800">
      <table className="w-full border-collapse text-[0.85rem]">
        <thead>
          <tr className="bg-ink-900">
            {header.map((cell, index) => (
              <th key={`${tableKey}-h${index}`} className="whitespace-nowrap border-b border-ink-800 px-2 py-1 text-left font-semibold text-white">
                {inlineNodes(cell, `${tableKey}-h${index}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${tableKey}-r${rowIndex}`} className="odd:bg-ink-900/40">
              {row.map((cell, cellIndex) => (
                <td key={`${tableKey}-r${rowIndex}c${cellIndex}`} className="border-b border-ink-850 px-2 py-1 align-top">
                  {inlineNodes(cell, `${tableKey}-r${rowIndex}c${cellIndex}`)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // A table is a pipe row followed by a separator row.
    if (line.trim().startsWith("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      flush();
      const header = cellsOf(line);
      const rows: string[][] = [];
      let cursor = index + 2;
      while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
        rows.push(cellsOf(lines[cursor]));
        cursor += 1;
      }
      blocks.push(<Table key={`${key}-t${blocks.length}`} header={header} rows={rows} tableKey={`${key}-t${blocks.length}`} />);
      index = cursor - 1;
      continue;
    }
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
  return <div className="prose-chat text-base leading-relaxed">{nodes}</div>;
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
  return <span className={`${tone} text-[0.8rem] ${state === "running" ? "spinner-dot" : ""}`}>{glyph}</span>;
}

export function ToolCard({ block }: { block: ChatToolBlock }) {
  const [open, setOpen] = useState(false);
  const result = block.result ?? "";
  const args = typeof block.args === "string" ? block.args : JSON.stringify(block.args, null, 2);
  return (
    <div className="my-1 overflow-hidden rounded-xl border border-ink-800 bg-ink-900/70">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ToolState state={block.state} />
        <span className="font-mono text-[0.85rem] text-ink-200">{block.name}</span>
        <span className="min-w-0 flex-1 truncate text-[0.85rem] text-ink-400">{toolSummary(block)}</span>
        <span className="text-[0.75rem] text-ink-400">{open ? "▾" : "▸"}</span>
      </button>
      {open ? (
        <div className="space-y-2 border-t border-ink-850 px-3 py-2">
          {args && args !== "{}" ? (
            <pre className="scroll-y max-h-52 rounded-lg bg-ink-950 p-2 text-[0.8rem] text-ink-200">{args}</pre>
          ) : null}
          {result ? (
            <pre className="scroll-y max-h-72 rounded-lg bg-ink-950 p-2 text-[0.8rem] whitespace-pre-wrap text-ink-200">{result}</pre>
          ) : (
            <div className="text-[0.8rem] text-ink-400">no output yet</div>
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
      <div className="my-2 text-center text-[0.8rem] text-ink-400">
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
              <details key={`${message.id}-${index}`} className="my-1 text-[0.85rem] text-ink-400">
                <summary className="cursor-pointer select-none">thinking</summary>
                <div className="prose-chat mt-1 border-l-2 border-ink-800 pl-2 italic">{block.text}</div>
              </details>
            );
          }
          if (block.kind === "error") {
            return (
              <div key={`${message.id}-${index}`} className="my-1 rounded-lg border border-[var(--color-blocked)]/40 px-2 py-1 text-[0.9rem] text-[var(--color-blocked)]">
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

/** A turn is one prompt plus everything the agent wrote before the next one. */
function turnsOf(messages: ChatMsg[]): ChatMsg[][] {
  const turns: ChatMsg[][] = [];
  for (const message of messages) {
    // A trimmed transcript can start mid-turn: those messages form no turn of their own.
    if (message.role === "user" || !turns.length) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  return turns;
}

/** When the prompt that started the turn was written, when the transcript still holds it. */
function turnStart(turn: ChatMsg[]): number | null {
  const [first] = turn;
  const ms = first.role === "user" ? Date.parse(first.at ?? "") : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Milliseconds from the prompt to the last thing the agent said in that turn. */
function turnSpan(turn: ChatMsg[]): number | null {
  const from = Date.parse(turn[0].at ?? "");
  const to = Date.parse(turn[turn.length - 1].at ?? "");
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : null;
}

/** Counts up while the agent is still on the turn; the transcript only has finished records. */
function TurnTimer({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span>{formatDuration(Math.max(0, now - since))}</span>;
}

export function MessageList({ session, running = false, waiting = false }: { session: ChatSession; running?: boolean; waiting?: boolean }) {
  const turns = useMemo(() => turnsOf(session.messages), [session.messages]);
  if (!session.messages.length) {
    return (
      <div className="p-6 text-center text-sm text-ink-400">
        {waiting
          ? "Waiting for herdr to report this agent's session…"
          : session.awaitingFirstMessage
            ? "No messages yet — this agent has not taken its first turn. Prompt it below."
            : session.error
              ? session.error
              : "No transcript yet — prompt the agent or open the Terminal tab."}
      </div>
    );
  }
  return (
    <div className="px-3 pb-2">
      {session.truncated ? <div className="py-2 text-center text-[0.8rem] text-ink-400">earlier messages trimmed</div> : null}
      {turns.map((turn, index) => {
        const start = turnStart(turn);
        const live = running && index === turns.length - 1 && start !== null;
        const span = live || start === null ? null : turnSpan(turn);
        return (
          <Fragment key={turn[0].id}>
            {turn.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {live ? (
              <div className="pb-1 pl-1 text-[0.75rem] text-[var(--color-working)]">
                <span className="spinner-dot">●</span> <TurnTimer since={start} />
              </div>
            ) : span !== null ? (
              <div className="pb-1 pl-1 text-[0.75rem] text-ink-400" title="time this turn took">
                {formatDuration(span)}
              </div>
            ) : null}
          </Fragment>
        );
      })}
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
      <div className="mb-1 flex items-center gap-2 text-[0.8rem] font-semibold tracking-wide text-[var(--color-blocked)] uppercase">
        <span className="spinner-dot">●</span> agent is asking
        {pending.questions.length > 1 ? (
          <span className="text-ink-400 normal-case">
            {reviewing ? "review" : `question ${stage + 1} of ${pending.questions.length}`}
          </span>
        ) : null}
      </div>
      <div className="prose-chat text-base text-white">{question.question}</div>

      <div className={`mt-2 space-y-1.5 ${reviewing ? "hidden" : ""}`}>
        {question.multi
          ? question.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => void toggle(index)}
                className={`tap w-full rounded-xl border px-3 py-2 text-left text-base ${
                  toggled.includes(index) ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15" : "border-ink-700 bg-ink-900"
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs ${toggled.includes(index) ? "text-[var(--color-accent)]" : "text-ink-400"}`}>
                    {toggled.includes(index) ? "◼" : "◻"}
                  </span>
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <span className={`font-mono text-[0.7rem] ${cursor === index ? "text-[var(--color-accent)]" : "text-ink-400"}`}>
                    {describe(keysTo(index, ["␣"]))}
                  </span>
                </div>
                {option.description ? <div className="mt-0.5 pl-5 text-[0.85rem] text-ink-400">{option.description}</div> : null}
              </button>
            ))
          : question.options.map((option, index) => (
              <button
                key={option.label}
                type="button"
                onClick={() => void pick(index)}
                className="tap w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-left text-base active:bg-ink-800"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1">{option.label}</span>
                  <span className="font-mono text-[0.7rem] text-ink-400">{describe(keysTo(index, ["⏎"]))}</span>
                </div>
                {option.description ? <div className="mt-0.5 text-[0.85rem] text-ink-400">{option.description}</div> : null}
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
          className="field scroll-y max-h-32 min-h-11 flex-1 resize-none"
        />
        <Button onClick={() => void sendCustom()} disabled={!custom.trim()}>
          Send
        </Button>
      </div>

      {sent ? <div className="mt-2 text-[0.8rem] text-ink-400">{sent}</div> : null}
      {error ? <div className="mt-2 text-[0.8rem] text-[var(--color-blocked)]">{error}</div> : null}
      {screen ? (
        <details className="mt-2 text-[0.8rem] text-ink-400" open>
          <summary className="cursor-pointer select-none">terminal dialog</summary>
          <pre ref={preview} className="scroll-y mt-1 max-h-40 rounded-lg bg-ink-950 p-2 text-[0.75rem] whitespace-pre text-ink-200">
            {screen}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- plan mode -- */

/**
 * omp's plan-mode review select in omp's own order and wording. "Approve and keep context"
 * is index 2 and omp disables that row above 95% context, where `down` skips it — the key
 * math has to skip the row too, or the tap lands on "Refine plan".
 */
const PLAN_OPTIONS = [
  { label: "Approve and execute", hint: "fresh context — the session is cleared first" },
  { label: "Approve and compact context", hint: "discussion distilled, then it runs here" },
  { label: "Approve and keep context", hint: "runs here, with the exploration history", keepRow: true },
  { label: "Refine plan", hint: "keeps planning — type the change, or send it as a follow-up" },
  { label: "Save and quit", hint: "copies the plan to a chosen path, then starts a new session" },
];

/** Title of omp's overlay; the select only takes keys while it is on screen. */
const PLAN_DIALOG = /plan mode - next step/i;

/**
 * Answers omp's plan review. The select is a list cursor driven by `down`/`enter` — never
 * `up`, which parks the overlay in its scroll body — so one tap is one delta from row 0,
 * and the row omp hides above 95% context is dropped from the list to keep that math true.
 */
export function PlanCard({
  paneId,
  plan,
  tokens,
  max,
  session,
}: {
  paneId: string;
  plan: PlanProposal;
  /** Live context and its window: omp disables "keep context" when the fill is over 95%. */
  tokens?: number;
  max?: number;
  session?: string;
}) {
  const [screen, setScreen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Set by a send: keystrokes cannot be un-sent, so the rows stay locked until the select closes. */
  const [locked, setLocked] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dropped = tokens !== undefined && max !== undefined && tokens / max > 0.95;
  /** The row omp disables at >95% context; navigation skips it, so the delta has to as well. */
  const hidden = dropped ? PLAN_OPTIONS.findIndex((option) => option.keepRow) : -1;
  const rows = PLAN_OPTIONS.map((option, index) => ({ ...option, index })).filter((row) => !(dropped && row.keepRow));
  const keysTo = (index: number) =>
    Array.from({ length: hidden >= 0 && index > hidden ? index - 1 : index }, () => "down").concat("enter");
  const describe = (keys: string[]) => keys.map((key) => (key === "down" ? "↓" : key === "enter" ? "⏎" : key)).join(" ");

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      if (document.hidden) return;
      let text: string | null = null;
      try {
        const response = await fetch(`/api/pane-text?pane=${encodeURIComponent(paneId)}&lines=24&source=visible`, { cache: "no-store" });
        const payload = (await response.json()) as { text?: string };
        text = payload.text ?? "";
      } catch {
        /* an unread screen is not a licence to type: keys stay locked below */
      }
      if (!alive || text === null) return;
      setScreen(text);
      // omp reopens the select on row 0, so once it is gone the cursor we track is stale no more.
      if (!PLAN_DIALOG.test(text)) setLocked(false);
    };
    void poll();
    const timer = setInterval(() => void poll(), 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [paneId]);

  // Until the pane has been read there is nothing to go on, so the first paint stays enabled.
  const open = screen === null || PLAN_DIALOG.test(screen);
  const pick = async (index: number, label: string) => {
    setBusy(true);
    setError(null);
    try {
      const keys = keysTo(index);
      await callAction("pane.send_keys", { pane_id: paneId, keys }, 30_000, session);
      setLocked(true);
      setSent(`sent ${describe(keys)} — ${label}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 px-3 py-3">
      <div className="mb-1 flex items-center gap-2 text-[0.8rem] font-semibold tracking-wide text-[var(--color-accent)] uppercase">
        <span className="spinner-dot">●</span> plan ready for review
      </div>
      <div className="prose-chat text-base text-white">{plan.title || "plan"}</div>
      <div className="mt-0.5 font-mono text-[0.75rem] text-ink-400">
        {plan.file ?? (plan.title ? `local://${plan.title}-plan.md` : "")}
      </div>

      <div className="mt-2 space-y-1.5">
        {rows.map((row) => (
          <button
            key={row.label}
            type="button"
            disabled={busy || !open || locked}
            onClick={() => void pick(row.index, row.label)}
            className="tap w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-left text-base active:bg-ink-800 disabled:opacity-50"
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{row.label}</span>
              <span className="font-mono text-[0.7rem] text-ink-400">{describe(keysTo(row.index))}</span>
            </div>
            <div className="mt-0.5 text-[0.85rem] text-ink-400">{row.hint}</div>
          </button>
        ))}
      </div>

      {dropped ? <div className="mt-2 text-[0.8rem] text-ink-400">context is over 95% full — omp hides “Approve and keep context”</div> : null}
      {!open ? (
        <div className="mt-2 text-[0.8rem] text-ink-400">
          the review select is not on screen any more — reopen it in the agent with <code>/plan-review</code>
        </div>
      ) : null}
      {sent ? <div className="mt-2 text-[0.8rem] text-ink-400">{sent}</div> : null}
      {error ? <div className="mt-2 text-[0.8rem] text-[var(--color-blocked)]">{error}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------ model switch -- */

/**
 * Model chip for a running agent. The agents that take a `--model` flag also take
 * `/model <id>` in their own TUI, so the switch is one prompt away; the agent writes the
 * change into its transcript, which is why the label follows the session file.
 */
export function ModelChip({
  paneId,
  session,
  agent,
  model,
}: {
  paneId: string;
  session?: string;
  agent: string | null | undefined;
  model: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSent(null);
    fetch(`/api/models?kind=${encodeURIComponent(agent ?? "")}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { supported?: boolean; models?: string[]; note?: string }) => {
        setModels(payload.models ?? []);
        setNote(payload.note ?? null);
      })
      .catch(() => setModels([]));
  }, [open, agent]);

  if (!supportsModel(agent ?? "")) return null;

  const switchTo = async (target: string) => {
    const command = modelCommand(agent, target);
    if (!command) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane: paneId, text: command, session: session ?? activeSession() }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSent(command);
      setTyped("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <IconButton label={`Model: ${model ?? "unknown"} — tap to switch`} tone="accent" onClick={() => setOpen(true)}>
        <span className="max-w-28 truncate">{model?.split("/").pop() ?? "model"}</span>
      </IconButton>

      <Sheet open={open} onClose={() => setOpen(false)} title="Model">
        <div className="space-y-3">
          <div className="rounded-xl border border-ink-800 px-3">
            <Row label="in use" value={model ?? "not reported"} />
          </div>
          {/* Capped so the typed-id field and the actions stay on screen, however long the list is. */}
          <div className="scroll-y max-h-[40dvh] space-y-2">
            {models.map((entry) => (
              <Button
                key={entry}
                full
                size="sm"
                tone={entry.split("/").pop() === model?.split("/").pop() ? "accent" : "default"}
                disabled={busy}
                onClick={() => void switchTo(entry)}
              >
                <span className="min-w-0 flex-1 truncate text-left">{entry}</span>
              </Button>
            ))}
          </div>
          {models.length === 0 ? (
            <p className="text-[0.75rem] text-ink-400">
              {note ?? "no models found on this machine — type an id below"}
            </p>
          ) : null}
          <div className="flex gap-2">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && typed.trim() && !busy) void switchTo(typed.trim());
              }}
              placeholder="other model id"
              className="field min-w-0 flex-1"
            />
            <Button tone="primary" disabled={busy || !typed.trim()} onClick={() => void switchTo(typed.trim())}>
              {busy ? "…" : "Switch"}
            </Button>
          </div>
          {sent ? <p className="text-[0.75rem] text-[var(--color-done)]">sent {sent} — the agent switches on its next turn</p> : null}
          {error ? <p className="text-[0.75rem] text-[var(--color-blocked)]">{error}</p> : null}
          <p className="text-[0.7rem] text-ink-400">
            Sent as the agent's own <code>/model</code> command, so the conversation continues in the same session.
          </p>
        </div>
      </Sheet>
    </>
  );
}

/* -------------------------------------------------------------- composer -- */

export function Composer({
  paneId,
  session,
  hasAgent = true,
  running = false,
  showKeys = true,
  placeholder = "Message this agent…",
}: {
  paneId: string;
  session?: string;
  hasAgent?: boolean;
  /** The agent is mid-turn: only then can it be stopped. */
  running?: boolean;
  /** The raw key row belongs to the Terminal tab. */
  showKeys?: boolean;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useAutoGrow(draft, 160);

  const send = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/prompt", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pane: paneId, text, session: session ?? activeSession() }),
      });
      const payload = (await response.json()) as { warning?: string; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      if (payload.warning) setError(payload.warning);
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
      {error ? <div className="pb-1 text-[0.8rem] text-[var(--color-blocked)]">{error}</div> : null}
      <div className="flex items-end gap-2">
        <IconButton
          label={running ? "Stop this turn (Esc)" : "Nothing to stop — the agent is not working"}
          tone="danger"
          size="md"
          disabled={!running}
          onClick={() => void key(hasAgent ? ["esc"] : ["ctrl+c"])}
        >
          ■
        </IconButton>
        <textarea
          ref={draftRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          rows={1}
          placeholder={hasAgent ? placeholder : "Run in this shell…"}
          className="field scroll-y max-h-40 min-h-11 flex-1 resize-none"
        />
        <Button tone="primary" disabled={busy || !draft.trim()} onClick={() => void send()}>
          {busy ? "…" : "Send"}
        </Button>
      </div>
      {error ? <div className="pt-1 text-[0.75rem] text-[var(--color-blocked)]">{error}</div> : null}
      <div className={`mt-1 gap-1.5 overflow-x-auto no-scrollbar pb-1 ${showKeys ? "flex" : "hidden"}`}>
        {(
          [
            ["esc", "esc"],
            ["ctrl+c", "ctrl+c"],
            ["enter", "enter"],
            ["up", "↑"],
            ["down", "↓"],
            ["left", "←"],
            ["right", "→"],
            ["tab", "tab"],
          ] as const
        ).map(([name, label]) => (
          <Button key={name} size="sm" onClick={() => void key([name])}>
            {label}
          </Button>
        ))}
      </div>
    </div>
  );
}
