import net from "node:net";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

export const CONFIG_DIR = process.env.HERDR_CONFIG_DIR ?? path.join(os.homedir(), ".config", "herdr");

/** Newest live socket wins; HERDR_SOCKET_PATH (injected by herdr into its panes) beats discovery. */
export function resolveSocketPath(): string {
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_SESSION) {
    return path.join(CONFIG_DIR, "sessions", process.env.HERDR_SESSION, "herdr.sock");
  }
  const candidates = [path.join(CONFIG_DIR, "herdr.sock")];
  const sessionsDir = path.join(CONFIG_DIR, "sessions");
  try {
    for (const name of fs.readdirSync(sessionsDir)) {
      candidates.push(path.join(sessionsDir, name, "herdr.sock"));
    }
  } catch {
    /* no sessions dir yet */
  }
  const live = candidates.filter((candidate) => fs.existsSync(candidate));
  if (live.length) {
    live.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return live[0];
  }
  return path.join(CONFIG_DIR, "sessions", "default", "herdr.sock");
}

export const SOCKET_PATH = resolveSocketPath();

/**
 * One request over a dedicated connection.
 *
 * herdr answers a request and then closes that connection (the shipped CLI does
 * one request per process for the same reason), so connections are never pooled:
 * a long-lived request connection just flaps. Subscriptions use `herdrStream`.
 */
export function herdrRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 20_000,
  socketPath: string = SOCKET_PATH,
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const sock = net.createConnection({ path: socketPath });
  sock.setEncoding("utf8");
  let buffer = "";
  let settled = false;

  const finish = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    sock.destroy();
    fn();
  };

  const timer = setTimeout(() => finish(() => reject(new Error(`timeout: ${method} (${socketPath})`))), timeoutMs);

  sock.on("connect", () => {
    sock.write(`${JSON.stringify({ id: "ab", method, params })}\n`);
  });

  sock.on("data", (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).trim();
    if (!line) return;
    let message: { result?: unknown; error?: { code?: string; message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.error) {
      finish(() => reject(new Error(`${message.error?.code ?? "error"}: ${message.error?.message ?? method}`)));
      return;
    }
    finish(() => resolve(message.result as T));
  });

  sock.on("error", (err: Error) => {
    finish(() => reject(new Error(`${err.message} (${socketPath})`)));
  });

  sock.on("close", () => {
    finish(() => reject(new Error(`herdr closed the connection before answering ${method}`)));
  });

  return promise;
}
