import { sessionFromBody, socketForSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";

export const dynamic = "force-dynamic";

/** herdr refuses `agent.prompt` until its lifecycle integration reports the agent ready. */
const NOT_READY = /agent_not_ready|agent_not_found|not an active named agent|no agent/;
const BLOCKED = /agent_blocked/;

type PromptBody = { pane?: unknown; text?: unknown; session?: unknown };

/**
 * Prompt an agent.
 *
 * `agent.prompt` is preferred: herdr honors the pane's bracketed-paste mode and
 * rejects an agent that is sitting at a question instead of typing into it. When the
 * pane's agent has no ready lifecycle integration (outdated hooks, or an agent herdr
 * cannot vouch for) the same intent goes through `pane.send_input`, which writes the
 * text and the Enter as one ordered submission.
 */
export async function POST(request: Request): Promise<Response> {
  let body: PromptBody;
  try {
    body = (await request.json()) as PromptBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const socket = socketForSession(sessionFromBody(body.session));
  const pane = typeof body.pane === "string" ? body.pane : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!pane || !text.trim()) return Response.json({ error: "pane and text are required" }, { status: 400 });

  try {
    await herdrRequest("agent.prompt", { target: pane, text }, 30_000, socket);
    return Response.json({ via: "agent.prompt" }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = (err as Error).message;

    if (BLOCKED.test(message)) {
      return Response.json(
        { error: "This agent is waiting at a question — answer it from the question card instead of typing." },
        { status: 409 },
      );
    }
    if (!NOT_READY.test(message)) return Response.json({ error: message }, { status: 502 });

    try {
      await herdrRequest("pane.send_input", { pane_id: pane, text, keys: ["enter"] }, 20_000, socket);
      return Response.json(
        { via: "send_input", warning: `${message} — sent as raw input instead` },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (fallbackErr) {
      return Response.json({ error: (fallbackErr as Error).message }, { status: 502 });
    }
  }
}
