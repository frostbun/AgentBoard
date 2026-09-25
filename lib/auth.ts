/**
 * Access token for the board.
 *
 * Default HOST is 0.0.0.0, so the board is reachable from the LAN and must not be
 * open by default: without `AGENTBOARD_TOKEN` a per-process token is generated and
 * printed at startup. `AGENTBOARD_OPEN=1` disables the check for a trusted network.
 *
 * Two constraints shape this module: the proxy runs on the Edge runtime (no
 * `node:crypto`), and bundlers give every route its own copy of the module, so the
 * generated token lives on `globalThis` — a module-scope value would produce one
 * token per copy and the proxy would reject the token the banner printed.
 */
const GLOBAL_KEY = "__agentboard_token__";
type TokenGlobal = typeof globalThis & { [GLOBAL_KEY]?: string };

function generatedToken(): string {
  const store = globalThis as TokenGlobal;
  if (!store[GLOBAL_KEY]) {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    store[GLOBAL_KEY] = `ab_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return store[GLOBAL_KEY];
}

export function boardToken(): string | null {
  if (process.env.AGENTBOARD_OPEN === "1") return null;
  return process.env.AGENTBOARD_TOKEN?.trim() || generatedToken();
}

export function tokenSource(): "env" | "generated" | "open" {
  if (process.env.AGENTBOARD_OPEN === "1") return "open";
  return process.env.AGENTBOARD_TOKEN?.trim() ? "env" : "generated";
}
