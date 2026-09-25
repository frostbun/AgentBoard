import { extractInputLine } from "@/lib/herdr/input-line";
import { findPane } from "@/lib/herdr/panes";
import { sessionFromRequest, socketForSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";

export const dynamic = "force-dynamic";

type PaneReadResponse = { read?: { text?: string }; text?: string };

/** The agent's current input line, so typing in herdr first shows up in the board. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const paneId = url.searchParams.get("pane") ?? "";
  const hit = await findPane(paneId, sessionFromRequest(request));
  if (!hit) return Response.json({ error: `unknown pane ${paneId}` }, { status: 404 });

  try {
    const response = await herdrRequest<PaneReadResponse>(
      "pane.read",
      { pane_id: paneId, source: "visible", lines: 40, format: "text", strip_ansi: true },
      15_000,
      socketForSession(hit.session),
    );
    const screen = response.read?.text ?? response.text ?? "";
    return Response.json({ text: extractInputLine(screen) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
