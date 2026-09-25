import { board } from "@/lib/herdr/board";
import { agentName, modelArgs, resumeArgs } from "@/lib/herdr/names";
import { sessionFromBody, socketForSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";
import type { BoardPane } from "@/lib/herdr/types";

export const dynamic = "force-dynamic";

type ResumeBody = { session?: unknown; workspace?: unknown; model?: unknown };

const PANE_RESULT = /type":\s*"pane_info/;

function pickPane(result: unknown): string | null {
  const pane = (result as { pane?: { pane_id?: string } } | null)?.pane;
  return typeof pane?.pane_id === "string" ? pane.pane_id : null;
}

/**
 * Reopen a workspace's most recent agent session in a new pane, using the agent's own resume
 * flag. herdr only reports session references for agents that are still running, so a pane
 * whose agent exited has nothing to resume.
 */
export async function POST(request: Request): Promise<Response> {
  let body: ResumeBody;
  try {
    body = (await request.json()) as ResumeBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const session = sessionFromBody(body.session);
  const workspaceId = typeof body.workspace === "string" ? body.workspace : "";
  const socket = socketForSession(session);

  const candidates = board(session)
    .getState()
    .panes.filter((pane) => pane.workspace_id === workspaceId && pane.agent && pane.agent_session)
    .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));

  const source: BoardPane | undefined = candidates[0];
  if (!source) {
    return Response.json(
      { error: "no resumable agent in this workspace — herdr reports a session only while the agent runs" },
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
        name: agentName(`${source.display_agent ?? source.agent}-resume`, source.agent ?? "agent"),
        kind: source.agent,
        pane_id: paneId,
        args,
        timeout_ms: 120_000,
      },
      180_000,
      socket,
    );
    board(session).scheduleRefresh(200);
    return Response.json({ pane_id: paneId, kind: source.agent, resumed: source.agent_session?.value ?? null });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
