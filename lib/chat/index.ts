import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentInfo, PaneInfo } from "../herdr/types";
import { projectSlug, trimMessages } from "../json";
import { claudeSessionPath, readClaudeSession } from "./claude";
import { readOmpSession } from "./omp";
import { readOpencodeSession } from "./opencode";
import { emptySession, type ChatSession } from "./types";

const OMP_AGENTS = new Set(["omp", "pi"]);
const CACHE_KEY = "__agentboard_chat_cache__";
const CACHE_MAX = 8;

type CacheEntry = { key: string; session: ChatSession };
type CacheStore = Map<string, CacheEntry>;

function cache(): CacheStore {
  const store = globalThis as typeof globalThis & { [CACHE_KEY]?: CacheStore };
  if (!store[CACHE_KEY]) store[CACHE_KEY] = new Map();
  return store[CACHE_KEY];
}

/** Parse a JSONL transcript only when the file changed. */
function readCachedFile(file: string, limit: number, parse: (file: string, limit: number) => ChatSession): ChatSession {
  const store = cache();
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}:${limit}`;
  const hit = store.get(file);
  if (hit && hit.key === key) return hit.session;
  const session = parse(file, limit);
  store.set(file, { key, session });
  if (store.size > CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  return session;
}

/** The host's home directory, when the board runs in a container against a mounted herdr. */
const HOST_HOME = process.env.AGENTBOARD_HOST_HOME ?? "";

/**
 * herdr reports paths from the machine it runs on. Inside a container those live under the
 * mounted home instead, so the host prefix is rewritten — otherwise every transcript looks
 * like a session that has not started yet.
 */
function remapHostPath(file: string): string {
  if (!HOST_HOME) return file;
  if (file === HOST_HOME) return os.homedir();
  if (file.startsWith(`${HOST_HOME}/`)) return path.join(os.homedir(), file.slice(HOST_HOME.length + 1));
  return file;
}

/** True when a path clearly belongs to another machine's filesystem. */
function isForeignPath(file: string): boolean {
  return !file.startsWith(os.homedir()) && !(HOST_HOME && file.startsWith(HOST_HOME));
}

function findOmpSessionFile(sessionId: string, cwd: string | null): string | null {
  const root = path.join(os.homedir(), ".omp", "agent", "sessions");
  const dirs = cwd ? [path.join(root, projectSlug(cwd)), root] : [root];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    const match = entries.find((name) => name.endsWith(`${sessionId}.jsonl`));
    if (match) return path.join(dir, match);
  }
  return null;
}

function resolvePath(ref: { agent: string; kind: string; value: string }, cwd: string | null): string | null {
  if (ref.kind === "path") return remapHostPath(ref.value);
  if (ref.agent === "claude") return claudeSessionPath(os.homedir(), cwd ?? process.cwd(), ref.value);
  if (OMP_AGENTS.has(ref.agent)) return findOmpSessionFile(ref.value, cwd);
  return null;
}

export type TranscriptTarget = {
  kind: "file" | "sqlite" | "none";
  path: string | null;
  /** `herdr` when herdr named the session, `none` when it did not — the board never guesses one. */
  refSource: "herdr" | "none";
  /** Named by herdr but not written yet: the agent has not taken its first turn. */
  pending?: boolean;
  note?: string;
};

function supported(agent: string): boolean {
  return agent === "claude" || agent === "opencode" || OMP_AGENTS.has(agent);
}

/** herdr learns a session only from the agent's own lifecycle integration, and only when that
 *  agent starts — there is nothing on disk that reliably says which session a pane is running. */
const NO_REFERENCE =
  "herdr has no session reference for this pane: the agent's integration reports one when it starts, so restart the agent and check `herdr integration status`";

/**
 * Where a pane's transcript lives on disk — the single resolver shared by the readers
 * and the tail watcher, so both agree on which file a pane is showing. It answers only
 * from herdr's own session reference; a missing one is reported as missing, never guessed
 * from the pane's directory (the newest file there may belong to a different agent).
 */
export function resolveTranscript(pane: PaneInfo | AgentInfo): TranscriptTarget {
  const agent = pane.agent ?? "unknown";
  const ref = pane.agent_session;
  const cwd = pane.foreground_cwd ?? pane.cwd ?? null;

  if (!supported(agent)) return { kind: "none", path: null, refSource: "none", note: `no transcript reader for agent "${agent}"` };
  if (!ref) return { kind: "none", path: null, refSource: "none", note: NO_REFERENCE };

  if (agent === "opencode" || ref.agent === "opencode") {
    const db = process.env.OPENCODE_DB ?? `${os.homedir()}/.local/share/opencode/opencode.db`;
    if (ref.kind !== "id") return { kind: "none", path: null, refSource: "none", note: `opencode reported a ${ref.kind} reference, not a session id` };
    return { kind: "sqlite", path: db, refSource: "herdr" };
  }

  const file = resolvePath(ref, cwd);
  if (!file) return { kind: "none", path: null, refSource: "none", note: `unhandled session reference (${ref.kind}) for agent "${agent}"` };
  // herdr names the file before the agent creates it, so hand the path on even when it is
  // missing: the reader reports "waiting", and the tail watcher attaches when it appears.
  return { kind: "file", path: file, refSource: "herdr", pending: !fs.existsSync(file) };
}

/**
 * Normalized transcript for a pane's agent, or a session with `source: "none"`
 * when the agent exposes no readable session (the UI falls back to the terminal).
 */
export function readAgentChat(pane: PaneInfo | AgentInfo, limit = 250): ChatSession {
  const agent = pane.agent ?? "unknown";
  const target = resolveTranscript(pane);

  if (target.kind === "none") return emptySession(agent, target.note);
  if (target.kind === "sqlite") return readOpencodeSession(pane.agent_session!.value, limit);

  const file = target.path;
  if (!file) return emptySession(agent, target.note);

  if (!fs.existsSync(file)) {
    const waiting = emptySession(
      agent,
      isForeignPath(file)
        ? `session file lives on another filesystem: ${file} — mount it (see AGENTBOARD_HOST_HOME)`
        : "waiting for the agent's first message…",
    );
    waiting.ref = file;
    waiting.refSource = target.refSource;
    waiting.awaitingFirstMessage = true;
    return waiting;
  }

  const isClaude = agent === "claude" || pane.agent_session?.agent === "claude";
  try {
    const session = readCachedFile(file, limit, isClaude ? readClaudeSession : readOmpSession);
    session.refSource = target.refSource;
    return session;
  } catch (err) {
    const session = emptySession(agent, `read failed: ${(err as Error).message}`);
    session.ref = file;
    return session;
  }
}
