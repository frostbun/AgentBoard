import { extractInputLine } from "@/lib/herdr/input-line";
import { sessionFromBody, socketForSession, unknownSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";

export const dynamic = "force-dynamic";

/** herdr refuses `agent.prompt` until its lifecycle integration reports the agent ready. */
const NOT_READY = /agent_not_ready|agent_not_found|not an active named agent|no agent/;
const BLOCKED = /agent_blocked/;

type PromptBody = { pane?: unknown; text?: unknown; session?: unknown };
type PaneReadResponse = { read?: { text?: string }; text?: string };

/**
 * Leave nothing in front of the prompt.
 *
 * `agent.prompt` appends, so a draft already sitting in the pane would ride along in front of the
 * prompt ("fix this" + "the tests" → "fix thisthe tests"). Backspace is the one key every agent TUI
 * and shell here deletes with, and the read only sees the visible rows, so a draft longer than the
 * screen is cleared in rounds until the line reads empty (three rounds is the ceiling; past that the
 * residue is a draft nobody can see). A blocked agent is left alone: a question dialog owns that row,
 * and `agent.prompt` refuses it anyway.
 */
async function clearInputLine(pane: string, socket: string): Promise<void> {
  const readInputLine = async () => {
    const response = await herdrRequest<PaneReadResponse>(
      "pane.read",
      { pane_id: pane, source: "visible", lines: 40, format: "text", strip_ansi: true },
      15_000,
      socket,
    );
    return extractInputLine(response.read?.text ?? response.text ?? "");
  };

  let line = await readInputLine();
  if (!line) return;
  const info = await herdrRequest<{ pane?: { agent_status?: string } }>("pane.get", { pane_id: pane }, 10_000, socket);
  if (info.pane?.agent_status === "blocked") return;

  for (let round = 0; round < 3 && line; round += 1) {
    const keys = Array.from({ length: line.length + 8 }, () => "backspace");
    await herdrRequest("pane.send_keys", { pane_id: pane, keys }, 20_000, socket);
    line = await readInputLine();
  }
}

/**
 * Prompt an agent.
 *
 * `agent.prompt` is preferred: herdr honors the pane's bracketed-paste mode and
 * rejects an agent that is sitting at a question instead of typing into it. When the
 * pane's agent has no ready lifecycle integration (outdated hooks, or an agent herdr
 * cannot vouch for) the same intent goes through `pane.send_input`, which writes the
 * text and the Enter as one ordered submission.
 *
 * Either way the input line is emptied first: both paths write at the cursor, so anything
 * already in the pane ends up in front of the prompt.
 */
export async function POST(request: Request): Promise<Response> {
  let body: PromptBody;
  try {
    body = (await request.json()) as PromptBody;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const session = sessionFromBody(body.session);
  const unknown = unknownSession(session);
  if (unknown) return unknown;
  const socket = socketForSession(session);
  const pane = typeof body.pane === "string" ? body.pane : "";
  const text = typeof body.text === "string" ? body.text : "";
  if (!pane || !text.trim()) return Response.json({ error: "pane and text are required" }, { status: 400 });

  // Best effort: a pane that cannot be read still gets the prompt, and the prompt reports its own failures.
  try {
    await clearInputLine(pane, socket);
  } catch {
    /* the prompt call below surfaces real failures */
  }

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
