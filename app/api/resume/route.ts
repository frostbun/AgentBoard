import { board } from "@/lib/herdr/board";
import { freeAgentName, modelArgs, resumeArgs } from "@/lib/herdr/names";
import { sessionFromBody, socketForSession, unknownSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";
import type { BoardPane } from "@/lib/herdr/types";

export const dynamic = "force-dynamic";

type ResumeBody = { session?: unknown; workspace?: unknown; pane?: unknown; model?: unknown };

const PANE_RESULT = /type":\s*"pane_info/;

function pickPane(result: unknown): string | null {
  const pane = (result as { pane?: { pane_id?: string } } | null)?.pane;
  return typeof pane?.pane_id === "string" ? pane.pane_id : null;
}

/**
 * Reopen a workspace agent's own session in a new pane, using its resume flag. The session
 * comes from herdr's reference and nothing else: an agent that never reported one (its
 * integration was missing or came later) has no session to continue, and says so.
 */
export async function POST(request: Request): Promise<Response> {
  let body: ResumeBody;
  try {
    body = (await request.json()) as ResumeBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const session = sessionFromBody(body.session);
  const unknown = unknownSession(session);
  if (unknown) return unknown;
  const workspaceId = typeof body.workspace === "string" ? body.workspace : "";
  const socket = socketForSession(session);
  const state = board(session).getState();

  const candidates = state.panes.filter((pane) => pane.workspace_id === workspaceId && pane.agent).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));

  // The sheet lets the user pick which session to continue; without a pick the newest pane wins.
  const requested = typeof body.pane === "string" ? body.pane : "";
  const source: BoardPane | undefined = requested ? candidates.find((pane) => pane.pane_id === requested) : candidates[0];
  if (!source) return Response.json({ error: "no agent in this workspace to continue" }, { status: 409 });

  if (!source.agent_session) {
    return Response.json(
      {
        error: `${source.agent} (${source.pane_id}) never reported a session to herdr — its integration reports one when the agent starts, so restart it and retry`,
      },
      { status: 409 },
    );
  }

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const resume = resumeArgs(source.agent, source.agent_session);
  if (!resume) {
    return Response.json({ error: `no resume flags known for agent "${source.agent}"` }, { status: 400 });
  }
  const args = [...modelArgs(source.agent ?? "", model), ...resume];

  try {
    const split = await herdrRequest<{ pane?: { pane_id?: string } }>(
      "pane.split",
      { target_pane_id: source.pane_id, direction: "right", cwd: source.foreground_cwd ?? source.cwd, focus: true },
      30_000,
      socket,
    );
    const paneId = pickPane(split);
    if (!paneId) return Response.json({ error: `unexpected split response: ${PANE_RESULT.test(JSON.stringify(split))}` }, { status: 502 });

    await herdrRequest(
      "agent.start",
      {
        name: freeAgentName(`${source.display_agent ?? source.agent}-resume`, state.agents.map((agent) => agent.name)),
        kind: source.agent,
        pane_id: paneId,
        args,
        timeout_ms: 120_000,
      },
      180_000,
      socket,
    );
    board(session).scheduleRefresh(200);
    return Response.json({ pane_id: paneId, kind: source.agent, resumed: source.agent_session.value });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
