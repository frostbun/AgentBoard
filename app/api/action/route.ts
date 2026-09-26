import { board } from "@/lib/herdr/board";
import { sessionFromBody, socketForSession, unknownSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";

export const dynamic = "force-dynamic";

/** Every herdr method the board is allowed to call. Everything else is refused. */
const ALLOWED = new Set([
  "agent.focus",
  "agent.get",
  "agent.list",
  "agent.prompt",
  "agent.read",
  "agent.rename",
  "agent.send_keys",
  "agent.start",
  "agent.wait",
  "layout.apply",
  "layout.export",
  "layout.set_split_ratio",
  "notification.show",
  "pane.close",
  "pane.current",
  "pane.focus",
  "pane.get",
  "pane.layout",
  "pane.list",
  "pane.move",
  "pane.process_info",
  "pane.read",
  "pane.rename",
  "pane.resize",
  "pane.send_keys",
  "pane.send_text",
  "pane.split",
  "pane.swap",
  "pane.zoom",
  "session.snapshot",
  "tab.close",
  "tab.create",
  "tab.focus",
  "tab.get",
  "tab.list",
  "tab.move",
  "tab.rename",
  "workspace.close",
  "workspace.create",
  "workspace.focus",
  "workspace.get",
  "workspace.list",
  "workspace.move",
  "workspace.rename",
  "worktree.create",
  "worktree.list",
  "worktree.open",
  "worktree.remove",
]);

type ActionBody = {
  method?: unknown;
  params?: unknown;
  timeout_ms?: unknown;
  session?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  let body: ActionBody;
  try {
    body = (await request.json()) as ActionBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const method = typeof body.method === "string" ? body.method : "";
  if (!ALLOWED.has(method)) {
    return Response.json({ error: `method not allowed: ${method || "(empty)"}` }, { status: 403 });
  }

  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};
  const timeoutMs = typeof body.timeout_ms === "number" && body.timeout_ms > 0 ? Math.min(body.timeout_ms, 300_000) : 30_000;

  const session = sessionFromBody(body.session);
  const unknown = unknownSession(session);
  if (unknown) return unknown;

  try {
    const result = await herdrRequest(method, params, timeoutMs, socketForSession(session));
    if (method !== "session.snapshot" && method !== "agent.list") board(session).scheduleRefresh(200);
    return Response.json({ result }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
