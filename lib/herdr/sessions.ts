import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR, SOCKET_PATH, herdrRequest } from "./rpc";

export type HerdrSession = {
  id: string;
  label: string;
  socket: string;
  /** A server answers on that socket right now. */
  alive: boolean;
  /** Socket file exists (it does not for a session that was never started). */
  started: boolean;
  current: boolean;
};

/** `~/.config/herdr/herdr.sock` is the unnamed default session; named ones live one dir deeper. */
export function sessionIdForSocket(socket: string): string {
  const match = /sessions\/([^/]+)\/herdr\.sock$/.exec(socket);
  return match ? match[1] : "default";
}

/**
 * A session id becomes one path segment under `sessions/` and one argv entry for the herdr
 * CLI, so a separator, a NUL byte, or a `.`/`..` segment must never get through: this is the
 * only place an id off the wire turns into a socket path.
 */
export function isSessionId(sessionId: string): boolean {
  return sessionId !== "" && sessionId !== "." && sessionId !== ".." && !/[/\\\0]/.test(sessionId);
}

/** A herdr session exists when the unnamed default is meant, or when its directory does. */
export function sessionExists(sessionId: string): boolean {
  if (sessionId === "default") return true;
  return isSessionId(sessionId) && fs.existsSync(path.join(CONFIG_DIR, "sessions", sessionId));
}

export function sessionSocket(sessionId: string): string {
  if (!sessionId || sessionId === "default") return path.join(CONFIG_DIR, "herdr.sock");
  if (!isSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
  return path.join(CONFIG_DIR, "sessions", sessionId, "herdr.sock");
}

const RESCAN_KEY = "__agentboard_session_rescan__";

/** Ask the federated stream to re-scan sessions now instead of waiting for its interval. */
export function requestSessionRescan(): void {
  (globalThis as typeof globalThis & { [RESCAN_KEY]?: number })[RESCAN_KEY] = Date.now();
}

export function sessionRescanRequested(): number {
  return (globalThis as typeof globalThis & { [RESCAN_KEY]?: number })[RESCAN_KEY] ?? 0;
}

/** herdr accepts named sessions; keep it to what is safe as a directory name and argv entry. */
export const SESSION_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Every session herdr knows about: sockets that exist, plus session directories that were
 * created but never started (they get a "start" button instead of a live board).
 */
export async function listSessions(): Promise<HerdrSession[]> {
  const candidates = new Map<string, { socket: string; started: boolean }>();
  const defaultSocket = path.join(CONFIG_DIR, "herdr.sock");
  if (fs.existsSync(defaultSocket)) candidates.set("default", { socket: defaultSocket, started: true });
  try {
    for (const name of fs.readdirSync(path.join(CONFIG_DIR, "sessions"))) {
      const socket = path.join(CONFIG_DIR, "sessions", name, "herdr.sock");
      candidates.set(name, { socket, started: fs.existsSync(socket) });
    }
  } catch {
    /* no sessions directory */
  }
  // The board's own resolved socket may be a session the scan above cannot see.
  candidates.set(sessionIdForSocket(SOCKET_PATH), { socket: SOCKET_PATH, started: true });

  const current = sessionIdForSocket(SOCKET_PATH);
  const sessions = await Promise.all(
    [...candidates].map(async ([id, { socket, started }]) => {
      let alive = false;
      let label = id;
      if (started) {
        try {
          alive = Boolean(await herdrRequest("ping", {}, 1500, socket));
        } catch {
          alive = false;
        }
      }
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(socket), "session.json"), "utf8")) as { label?: string };
        label = meta.label ?? id;
      } catch {
        /* no session.json: keep the directory name */
      }
      return { id, label, socket, alive, started, current: id === current };
    }),
  );
  return sessions.sort((a, b) => Number(b.alive) - Number(a.alive) || a.id.localeCompare(b.id));
}

export type CreateSessionResult = { session: HerdrSession } | { error: string };

/** Stops a session's headless server. The session directory (and its history) stays. */
export async function stopSession(name: string): Promise<{ stopped: boolean } | { error: string }> {
  if (!SESSION_NAME.test(name)) return { error: "invalid session name" };
  const socket = sessionSocket(name);
  if (!fs.existsSync(socket)) return { error: `session "${name}" is not running` };

  try {
    await new Promise<void>((resolve) => {
      const child = spawn("herdr", ["--session", name, "server", "stop"], { stdio: "ignore" });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(resolve, 8000).unref?.();
    });
  } catch (err) {
    return { error: `could not stop herdr: ${(err as Error).message}` };
  }

  // Wait for it to actually stop answering, so the UI does not show a ghost.
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      if (!(await herdrRequest("ping", {}, 800, socket))) break;
    } catch {
      requestSessionRescan();
      return { stopped: true };
    }
  }
  requestSessionRescan();
  return { stopped: true };
}

/** Stops a session and removes its directory. Refuses the unnamed default session. */
export async function deleteSession(name: string): Promise<{ deleted: boolean } | { error: string }> {
  if (name === "default") return { error: "the default session has no directory to delete" };
  if (!SESSION_NAME.test(name)) return { error: "invalid session name" };
  const stopped = await stopSession(name);
  if ("error" in stopped) {
    // A stale socket with no server is still worth cleaning up.
    if (!/is not running/.test(stopped.error)) return stopped;
  }
  const dir = path.dirname(sessionSocket(name));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return { error: `could not delete ${dir}: ${(err as Error).message}` };
  }
  requestSessionRescan();
  return { deleted: true };
}

/** Starts a headless herdr server for `name`, creating the session if it does not exist yet. */
export async function createSession(name: string): Promise<CreateSessionResult> {
  if (!SESSION_NAME.test(name)) {
    return { error: "name must be 1-32 chars of a-z, 0-9, dash or underscore" };
  }
  const socket = sessionSocket(name);
  if (fs.existsSync(socket)) {
    try {
      if (await herdrRequest("ping", {}, 1500, socket)) return { error: `session "${name}" is already running` };
    } catch {
      /* stale socket: fall through and start a server */
    }
  }

  try {
    const child = spawn("herdr", ["--session", name, "server"], { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {
      /* surfaced by the socket timeout below */
    });
  } catch (err) {
    return { error: `could not launch herdr: ${(err as Error).message}` };
  }

  // Wait for the server to come up so the caller can show it immediately.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    try {
      if (fs.existsSync(socket) && (await herdrRequest("ping", {}, 1500, socket))) {
        requestSessionRescan();
        const sessions = await listSessions();
        const session = sessions.find((entry) => entry.id === name);
        if (session) return { session };
      }
    } catch {
      /* still starting */
    }
  }
  return { error: `session "${name}" did not start within 10s — check \`herdr session list\`` };
}
