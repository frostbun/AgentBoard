/**
 * Runnable check for the session-id guard: `bun run check:sessions`.
 *
 * `?session=` and `{"session":…}` reach `sessionSocket()` and `board()` straight off the wire:
 * an id that is not one plain directory name under `sessions/` must never become a socket path,
 * and an id no session answers to must never mint a polling board.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-guard-"));
const sessions = path.join(root, "sessions");
fs.mkdirSync(path.join(sessions, "demo"), { recursive: true });
fs.mkdirSync(path.join(root, "rogue"), { recursive: true });
process.env.HERDR_CONFIG_DIR = root; // read at module load of lib/herdr/rpc.ts

const DEMO_SOCKET = path.join(sessions, "demo", "herdr.sock");
const ROGUE_SOCKET = path.join(root, "rogue", "herdr.sock");
/** Traversal id that lands on ROGUE_SOCKET when `sessions/` is only joined, never validated. */
const TRAVERSAL = path.relative(sessions, path.dirname(ROGUE_SOCKET)); // "../rogue"

/** Minimal herdr socket: one JSON line in, one JSON line out. */
async function fakeHerdr(socketPath: string, label: string) {
  const seen = { connections: 0, methods: [] as string[] };
  const snapshot = {
    version: "fake",
    protocol: 1,
    focused_workspace_id: "w1",
    focused_tab_id: "w1:t1",
    focused_pane_id: "w1:p1",
    workspaces: [{ workspace_id: "w1", number: 1, label, focused: true, active_tab_id: "w1:t1", tab_count: 1, pane_count: 1, agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", number: 1, label: "main", focused: true, pane_count: 1, agent_status: "idle" }],
    panes: [
      { pane_id: "w1:p1", workspace_id: "w1", tab_id: "w1:t1", terminal_id: "t1", focused: true, revision: 1, agent: "omp", agent_status: "idle", title: label, cwd: root },
    ],
    agents: [],
  };
  const server = net.createServer((sock) => {
    seen.connections += 1;
    let buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const message = JSON.parse(line) as { id?: string; method?: string };
        seen.methods.push(message.method ?? "?");
        if (message.method === "events.subscribe") {
          sock.write(`${JSON.stringify({ type: "subscription_started" })}\n`);
          continue;
        }
        const result = message.method === "session.snapshot" ? { snapshot } : { ok: true, method: message.method };
        sock.write(`${JSON.stringify({ id: message.id ?? "ab", result })}\n`);
      }
    });
    sock.on("error", () => {});
  });
  const listening = Promise.withResolvers<void>();
  server.listen(socketPath, listening.resolve);
  await listening.promise;
  return { seen, stop: () => server.close() };
}

const demo = await fakeHerdr(DEMO_SOCKET, "demo");
const rogue = await fakeHerdr(ROGUE_SOCKET, "rogue");

const sleep = (ms: number) => {
  const done = Promise.withResolvers<void>();
  setTimeout(done.resolve, ms);
  return done.promise;
};

// Dynamic, not static: HERDR_CONFIG_DIR above must be set before lib/herdr/rpc.ts reads it.
const { isSessionId, sessionSocket, sessionExists } = await import("@/lib/herdr/sessions");
const { board } = await import("@/lib/herdr/board");
const { GET: stateRoute } = await import("@/app/api/state/route");
const { GET: streamRoute } = await import("@/app/api/stream/route");
const { POST: actionRoute } = await import("@/app/api/action/route");

/** Read lazily: `board()` only creates the global map on its first call. */
const globals = globalThis as typeof globalThis & { __agentboard_boards__?: Map<string, unknown> };
const action = (body: unknown) =>
  actionRoute(new Request("http://board/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/* ---- ids stay inside sessions/ ---------------------------------------- */
assert.equal(sessionSocket("demo"), DEMO_SOCKET);
assert.equal(sessionSocket("default"), path.join(root, "herdr.sock"));
for (const bad of ["..", ".", "a/b", "a\\b", "a\0b", "../rogue"]) {
  assert.equal(isSessionId(bad), false, `isSessionId(${JSON.stringify(bad)})`);
  assert.equal(sessionExists(bad), false, `sessionExists(${JSON.stringify(bad)})`);
  assert.throws(() => sessionSocket(bad), /invalid session id/);
}
assert.equal(sessionExists("demo"), true);
assert.equal(sessionExists("default"), true);
assert.equal(sessionExists("ghost"), false);

/* ---- made-up ids mint no board and no timers --------------------------- */
const heapBefore = process.memoryUsage().heapUsed;
for (let i = 0; i < 200; i++) board(`ghost-${i}`);
assert.equal(globals.__agentboard_boards__?.size ?? 0, 0, "made-up ids must not be cached as boards");
assert.equal(board("ghost-1").getState().rev, 0);
assert.equal(board("ghost-1").getState().panes.length, 0);
assert.ok(process.memoryUsage().heapUsed - heapBefore < 16 * 1024 * 1024, "200 made-up ids must not cost ~60MB");

/* ---- made-up ids never open a socket ---------------------------------- */
const rogueBefore = rogue.seen.connections;
const traversed = encodeURIComponent(TRAVERSAL);
const traversalState = await stateRoute(new Request(`http://board/api/state?session=${traversed}`));
assert.equal(traversalState.status, 200);
assert.equal(((await traversalState.json()) as { panes: unknown[] }).panes.length, 0);
const traversalStream = await streamRoute(new Request(`http://board/api/stream?session=${traversed}`));
const traversalReader = traversalStream.body!.getReader();
await traversalReader.read();
await traversalReader.cancel();
const traversalAction = await action({ method: "pane.send_text", params: { pane_id: "w1:p1", text: "pwn" }, session: TRAVERSAL });
assert.equal(traversalAction.status, 400);
assert.match(((await traversalAction.json()) as { error: string }).error, /unknown session/);
await sleep(150);
assert.equal(rogue.seen.connections, rogueBefore, "the rogue socket must never be contacted");

/* ---- a real session still streams, polls and answers actions ---------- */
await stateRoute(new Request("http://board/api/state?session=demo"));
for (let i = 0; i < 40 && board("demo").getState().panes.length === 0; i++) await sleep(50);
assert.equal(board("demo").getState().connected, true);
assert.equal(board("demo").getState().panes.length, 1);
assert.ok(demo.seen.methods.includes("session.snapshot"), "the live session socket is used");
assert.equal((await action({ method: "workspace.list", session: "demo" })).status, 200);
assert.equal((await action({ method: "workspace.list", session: "ghost" })).status, 400);

/* ---- cleanup ---------------------------------------------------------- */
for (const cached of globals.__agentboard_boards__?.values() ?? []) (cached as { stop?: () => void }).stop?.();
demo.stop();
rogue.stop();
fs.rmSync(root, { recursive: true, force: true });
console.log("session guard ok");
