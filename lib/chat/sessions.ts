import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asArray, asRecord, asString } from "../json";
import { CLAUDE_INTERRUPTED, SYSTEM_TAG, claudeSessionDir } from "./claude";
import { readJsonlHead, readJsonlTail } from "./jsonl";
import { jsonColumn, openOpencodeDatabase } from "./opencode";
import type { AgentSessionSummary, SessionOutcome } from "./types";

/** Enough of the tail to hold the last turn: that is where an outcome is written. */
const TAIL_BYTES = 131_072;
/** The head carries the title record and the first prompt (Claude puts the prompt ~24 KB in). */
const HEAD_BYTES = 65_536;
const TITLE_MAX = 80;

/**
 * Every session the agents' own stores kept for these directories, newest first.
 *
 * A pane's herdr reference answers "which session is this pane running"; it says nothing
 * about the sessions that ran before it, whose panes are gone. Those live only in the
 * agents' stores — `<cwd>-scoped` for omp and claude, keyed by directory for opencode —
 * so the board lists them from there. omp and pi share one store, hence `omp` for both.
 */
export function listAgentSessions(cwds: readonly string[], options: { home?: string; hostHome?: string } = {}): AgentSessionSummary[] {
  const home = options.home ?? os.homedir();
  const slugHome = options.hostHome ?? process.env.AGENTBOARD_HOST_HOME ?? home;
  const dirs = [...new Set(cwds.map((cwd) => cwd.trim()).filter(Boolean))];
  if (!dirs.length) return [];

  const found = [...ompSessions(dirs, home, slugHome), ...claudeSessions(dirs, home), ...opencodeSessions(dirs, home)];
  const newest = new Map<string, AgentSessionSummary>();
  for (const session of found) {
    const key = `${session.agent}:${session.id}`;
    const previous = newest.get(key);
    if (!previous || previous.updated_at < session.updated_at) newest.set(key, session);
  }
  return [...newest.values()].sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * omp's per-directory session folder name: home-relative when the cwd lives under the home
 * (`/home/u/p` → `-p` with `-` for every separator), `-tmp…` under the temp dir, and the
 * full path wrapped in `--` otherwise. Mirrors omp's own `encodedDirName`.
 */
export function ompSessionDir(cwd: string, home: string): string {
  const relative = path.relative(home, cwd);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relative === "" ? "-" : `-${relative.replace(/[/\\:]/g, "-")}`;
  const inTmp = path.relative(os.tmpdir(), cwd);
  if (!inTmp.startsWith("..") && !path.isAbsolute(inTmp)) return inTmp === "" ? "-tmp" : `-tmp-${inTmp.replace(/[/\\:]/g, "-")}`;
  return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * How omp's own session list reads a transcript: the last message record's role and stop
 * reason say whether the turn finished, was cut short, or was stopped by the user.
 */
export function ompOutcome(records: readonly Record<string, unknown>[]): SessionOutcome {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (asString(record.type) !== "message") continue;
    const message = asRecord(record.message);
    const role = message ? asString(message.role) : null;
    if (!message || !role) continue;
    if (role === "assistant") {
      const stop = asString(message.stopReason);
      if (stop === "error") return "error";
      if (stop === "aborted") return "aborted";
      if (stop === "length") return "interrupted";
      const pendingTools = asArray(message.content).some((block) => asString(asRecord(block)?.type) === "toolCall");
      return pendingTools ? "interrupted" : "done";
    }
    if (role === "toolResult") return "interrupted";
    if (role === "user") return "pending";
    return "unknown";
  }
  return "unknown";
}

/**
 * Claude Code records no exit status, so the markers in its transcript decide: an interrupt
 * marker is an abort, a tool result or a mid-turn stop reason means the process went away
 * with work outstanding, and an unanswered prompt means the session never replied to it.
 */
export function claudeOutcome(records: readonly Record<string, unknown>[]): SessionOutcome {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.isSidechain === true || record.isMeta === true) continue;
    const type = asString(record.type);
    if (type !== "user" && type !== "assistant") continue;
    const message = asRecord(record.message);
    if (!message) continue;
    const content = message.content;

    if (type === "assistant") {
      const stop = asString(message.stop_reason);
      if (!stop) continue; // one of several content-block records of the same turn
      if (stop === "end_turn" || stop === "stop_sequence") return "done";
      if (stop === "max_tokens" || stop === "tool_use") return "interrupted";
      if (stop === "refusal") return "error";
      return "unknown";
    }

    if (typeof content === "string") {
      if (CLAUDE_INTERRUPTED.test(content)) return "aborted";
      if (SYSTEM_TAG.test(content.trim())) continue;
      if (content.trim()) return "pending";
      continue;
    }
    const parts = asArray(content).map(asRecord).filter((part): part is Record<string, unknown> => Boolean(part));
    if (parts.some((part) => asString(part.type) === "tool_result")) return "interrupted";
    const text = parts
      .filter((part) => asString(part.type) === "text")
      .map((part) => asString(part.text) ?? "")
      .join(" ")
      .trim();
    if (CLAUDE_INTERRUPTED.test(text)) return "aborted";
    if (text && !SYSTEM_TAG.test(text)) return "pending";
  }
  return "unknown";
}

/** opencode's message rows: the last one carries the finish reason and any error. */
export function opencodeOutcome(data: Record<string, unknown> | null): SessionOutcome {
  if (!data) return "unknown";
  if (asRecord(data.error)) return "error";
  if (asString(data.role) === "user") return "pending";
  const finish = asString(data.finish);
  if (finish === "stop") return "done";
  if (finish === "tool-calls" || finish === "length" || finish === "content-filter") return "interrupted";
  // A completion stamp with no finish reason is a stream that never ended properly.
  if (!finish && typeof asRecord(data.time)?.completed === "number") return "interrupted";
  return "unknown";
}

function jsonlFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** omp names files `<timestamp>_<id>.jsonl`; the id resumes, the rest dates the file. */
function ompSessionId(name: string): string | null {
  const separator = name.lastIndexOf("_");
  if (separator <= 0) return null;
  return name.slice(separator + 1, -".jsonl".length) || null;
}

function cleanTitle(text: string | null): string | null {
  if (!text) return null;
  const single = text.replace(/\s+/g, " ").trim();
  if (!single) return null;
  return single.length > TITLE_MAX ? `${single.slice(0, TITLE_MAX - 1)}…` : single;
}

/** The text of a transcript content field: a plain string or its text blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return asArray(content)
    .map((part) => asString(asRecord(part)?.text) ?? "")
    .join(" ")
    .trim();
}

/** The first real prompt, used when the store wrote no title. */
function firstUserText(records: readonly Record<string, unknown>[], agent: "omp" | "claude"): string | null {
  for (const record of records) {
    const message = asRecord(record.message);
    if (!message) continue;
    if (agent === "omp") {
      if (asString(record.type) !== "message" || asString(message.role) !== "user") continue;
    } else {
      if (asString(record.type) !== "user" || record.isMeta === true || record.isSidechain === true) continue;
      const prompt = messageText(message.content).trim();
      if (SYSTEM_TAG.test(prompt) || CLAUDE_INTERRUPTED.test(prompt)) continue;
    }
    const title = cleanTitle(messageText(message.content));
    if (title) return title;
  }
  return null;
}

/** The last title record in the slices — agents rewrite it as the session's work changes. */
function lastTitle(records: readonly Record<string, unknown>[], agent: "omp" | "claude"): string | null {
  let title: string | null = null;
  for (const record of records) {
    const type = asString(record.type);
    if (agent === "omp" && type === "title") title = cleanTitle(asString(record.title)) ?? title;
    if (agent === "claude" && type === "ai-title") title = cleanTitle(asString(record.aiTitle)) ?? title;
    if (agent === "claude" && type === "custom-title") title = cleanTitle(asString(record.customTitle)) ?? title;
    if (agent === "claude" && type === "summary") title = cleanTitle(asString(record.summary)) ?? title;
  }
  return title;
}

/**
 * One session's summary: the head holds the title, the tail holds the outcome. A session
 * whose records are unreadable lists as nothing rather than as a guess.
 */
function readSessionSummary(file: string, agent: "omp" | "claude", cwd: string, id: string): AgentSessionSummary | null {
  let updated_at: number;
  let head: Record<string, unknown>[];
  let tail: Record<string, unknown>[];
  try {
    updated_at = fs.statSync(file).mtimeMs;
    head = readJsonlHead(file, HEAD_BYTES);
    tail = readJsonlTail(file, TAIL_BYTES);
  } catch {
    return null;
  }
  const records = [...head, ...tail];
  return {
    agent,
    id,
    title: lastTitle(records, agent) ?? firstUserText(records, agent),
    cwd,
    updated_at,
    outcome: agent === "omp" ? ompOutcome(records) : claudeOutcome(records),
  };
}

function ompSessions(dirs: readonly string[], home: string, slugHome: string): AgentSessionSummary[] {
  const sessions: AgentSessionSummary[] = [];
  for (const cwd of dirs) {
    const dir = path.join(home, ".omp", "agent", "sessions", ompSessionDir(cwd, slugHome));
    for (const name of jsonlFiles(dir)) {
      const id = ompSessionId(name);
      if (!id) continue;
      const summary = readSessionSummary(path.join(dir, name), "omp", cwd, id);
      if (summary) sessions.push(summary);
    }
  }
  return sessions;
}

function claudeSessions(dirs: readonly string[], home: string): AgentSessionSummary[] {
  const sessions: AgentSessionSummary[] = [];
  for (const cwd of dirs) {
    const dir = claudeSessionDir(home, cwd);
    for (const name of jsonlFiles(dir)) {
      const id = name.slice(0, -".jsonl".length);
      if (!id) continue;
      const summary = readSessionSummary(path.join(dir, name), "claude", cwd, id);
      if (summary) sessions.push(summary);
    }
  }
  return sessions;
}

function opencodeSessions(dirs: readonly string[], home: string): AgentSessionSummary[] {
  const sessions: AgentSessionSummary[] = [];
  let db;
  try {
    db = openOpencodeDatabase(process.env.OPENCODE_DB ?? path.join(home, ".local/share/opencode/opencode.db"));
  } catch {
    return sessions; // no store on this machine: nothing to list
  }
  try {
    const placeholders = dirs.map(() => "?").join(", ");
    const rows = db
      .prepare(`select id, title, directory, time_updated from session where parent_id is null and time_archived is null and directory in (${placeholders})`)
      .all(...dirs);
    for (const row of rows) {
      const record = asRecord(row);
      if (!record) continue;
      const id = asString(record.id);
      const cwd = asString(record.directory);
      if (!id || !cwd) continue;
      const last = asRecord(db.prepare("select data from message where session_id = ? order by time_created desc, id desc limit 1").get(id));
      const raw = last ? jsonColumn(last.data) : null;
      const updated_at = typeof record.time_updated === "number" ? record.time_updated : Date.now();
      sessions.push({
        agent: "opencode",
        id,
        title: cleanTitle(asString(record.title)),
        cwd,
        updated_at,
        outcome: opencodeOutcome(raw),
      });
    }
  } catch {
    return sessions; // a database without the expected tables lists nothing
  }
  return sessions;
}
