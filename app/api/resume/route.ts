import { listAgentSessions } from "@/lib/chat/sessions";
import { board } from "@/lib/herdr/board";
import { freeAgentName, modelArgs, resumeArgs, sessionId } from "@/lib/herdr/names";
import { sessionFromBody, sessionFromRequest, socketForSession, unknownSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";
import type { AgentSessionRef, BoardPane } from "@/lib/herdr/types";

export const dynamic = "force-dynamic";

type ResumeBody = { session?: unknown; workspace?: unknown; pane?: unknown; agent?: unknown; id?: unknown; model?: unknown };

const PANE_RESULT = /type":\s*"pane_info/;

function pickPane(result: unknown): string | null {
  const pane = (result as { pane?: { pane_id?: string } } | null)?.pane;
  return typeof pane?.pane_id === "string" ? pane.pane_id : null;
}

function paneCwd(pane: BoardPane): string | null {
  return pane.foreground_cwd ?? pane.cwd ?? null;
}

/** The directories a workspace's panes live in — where its agents keep their sessions. */
function workspaceCwds(panes: BoardPane[]): string[] {
  return [...new Set(panes.map(paneCwd).filter((cwd): cwd is string => Boolean(cwd)))];
}

/** pi and omp keep one store, so a live pi pane is the store's `omp` session. */
function storeAgent(agent: string | null | undefined): string {
  return agent === "pi" ? "omp" : (agent ?? "");
}

/** The session ids live panes already show; the sheet lists those from herdr itself. */
function liveSessions(panes: BoardPane[]): Set<string> {
  const live = new Set<string>();
  for (const pane of panes) {
    if (!pane.agent || !pane.agent_session) continue;
    live.add(`${storeAgent(pane.agent)}:${sessionId(pane.agent_session)}`);
  }
  return live;
}

/**
 * The workspace's older sessions: what the agents' own stores kept for its directories,
 * minus the ones a live pane is already showing. This is the half herdr cannot answer —
 * a pane that was closed takes its `agent_session` reference with it.
 */
export async function GET(request: Request): Promise<Response> {
  const session = sessionFromRequest(request);
  const unknown = unknownSession(session);
  if (unknown) return unknown;
  const workspaceId = new URL(request.url).searchParams.get("workspace") ?? "";
  const panes = board(session).getState().panes.filter((pane) => pane.workspace_id === workspaceId);
  const cwds = workspaceCwds(panes);
  if (!cwds.length) return Response.json({ cwd: null, sessions: [] });
  const live = liveSessions(panes);
  const sessions = listAgentSessions(cwds).filter((entry) => !live.has(`${entry.agent}:${entry.id}`));
  return Response.json({ cwd: cwds[0], sessions });
}

/**
 * Reopen a session in a new pane, using the agent's own resume flag. Two sources: a live
 * pane continues herdr's own session reference (nothing else — an agent that never reported
 * one has no session to continue), and a past session comes from the ids the stores listed
 * for this workspace's directories.
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
  const panes = state.panes.filter((pane) => pane.workspace_id === workspaceId);

  // Newest first: the newest pane herdr named a session for is the natural default split.
  const agentPanes = panes.filter((pane) => pane.agent).sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));

  const wantedId = typeof body.id === "string" ? body.id.trim() : "";
  const requested = typeof body.pane === "string" ? body.pane : "";
  let target: BoardPane | undefined;
  let splitCwd: string | null;
  let kind: string;
  let ref: AgentSessionRef;
  let label: string;

  if (wantedId) {
    const agent = typeof body.agent === "string" ? body.agent : "";
    const match = listAgentSessions(workspaceCwds(panes)).find((entry) => entry.agent === agent && entry.id === wantedId);
    if (!match) return Response.json({ error: `${agent || "that agent"} has no session "${wantedId}" in this workspace` }, { status: 409 });
    kind = match.agent;
    ref = { source: "board", agent: match.agent, kind: "id", value: match.id };
    label = match.agent;
    // The pane may live in another directory than the session was started in.
    splitCwd = match.cwd;
    target = agentPanes[0] ?? panes[0];
  } else {
    const source = requested ? agentPanes.find((pane) => pane.pane_id === requested) : agentPanes[0];
    if (!source) return Response.json({ error: "no agent in this workspace to continue" }, { status: 409 });
    if (!source.agent_session) {
      return Response.json(
        {
          error: `${source.agent} (${source.pane_id}) never reported a session to herdr — its integration reports one when the agent starts, so restart it and retry`,
        },
        { status: 409 },
      );
    }
    kind = source.agent ?? "";
    ref = source.agent_session;
    label = source.display_agent ?? source.agent ?? kind;
    splitCwd = paneCwd(source);
    target = source;
  }
  if (!target) return Response.json({ error: "no pane in this workspace to open the session in" }, { status: 409 });

  const model = typeof body.model === "string" && body.model.trim() ? body.model.trim() : null;
  const resume = resumeArgs(kind, ref);
  if (!resume) {
    return Response.json({ error: `no resume flags known for agent "${kind}"` }, { status: 400 });
  }
  const args = [...modelArgs(kind, model), ...resume];

  try {
    const split = await herdrRequest<{ pane?: { pane_id?: string } }>(
      "pane.split",
      { target_pane_id: target.pane_id, direction: "right", cwd: splitCwd, focus: true },
      30_000,
      socket,
    );
    const paneId = pickPane(split);
    if (!paneId) return Response.json({ error: `unexpected split response: ${PANE_RESULT.test(JSON.stringify(split))}` }, { status: 502 });

    const start = {
      name: freeAgentName(`${label}-resume`, state.agents.map((agent) => agent.name)),
      kind,
      pane_id: paneId,
      args,
      timeout_ms: 120_000,
    };
    // A fresh split's shell is not at its prompt the instant the pane exists, and herdr
    // refuses `agent.start` with `agent_pane_busy` until it is. The ready shell arrives
    // within a few hundred ms (a shell with a heavy rc longer), so retry briefly.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await herdrRequest("agent.start", start, 180_000, socket);
        break;
      } catch (err) {
        const busy = /agent_pane_busy|not an available shell/i.test((err as Error).message);
        if (!busy || attempt >= 8) throw err;
        const backoff = Promise.withResolvers<void>();
        setTimeout(backoff.resolve, 250 * attempt);
        await backoff.promise;
      }
    }
    // The client navigates straight to the new pane, which needs its herdr session
    // reference to read the transcript. `agent.start` returns before herdr's own snapshot
    // exposes it, so poll a moment until the pane is nameable.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      await board(session).refresh();
      const started = board(session).getState().panes.find((pane) => pane.pane_id === paneId);
      if (started?.agent_session) break;
      const wait = Promise.withResolvers<void>();
      setTimeout(wait.resolve, 300);
      await wait.promise;
    }
    board(session).scheduleRefresh(200);
    return Response.json({ pane_id: paneId, kind, resumed: sessionId(ref) });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
