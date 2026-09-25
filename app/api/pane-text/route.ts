import { findPane } from "@/lib/herdr/panes";
import { sessionFromRequest, socketForSession } from "@/lib/herdr/request";
import { herdrRequest } from "@/lib/herdr/rpc";

export const dynamic = "force-dynamic";

const SOURCES = new Set(["visible", "recent", "recent_unwrapped", "detection"]);

/** Raw terminal text for a pane — the fallback view for agents without a readable transcript. */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const paneId = url.searchParams.get("pane") ?? "";
  const sourceParam = url.searchParams.get("source") ?? "recent_unwrapped";
  const source = SOURCES.has(sourceParam) ? sourceParam : "recent_unwrapped";
  const lines = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 400) || 400, 20), 4000);

  const hit = await findPane(paneId, sessionFromRequest(request));
  if (!hit) return Response.json({ error: `unknown pane ${paneId}` }, { status: 404 });

  try {
    const response = await herdrRequest<PaneReadResponse>(
      "pane.read",
      { pane_id: paneId, source, lines, format: "text", strip_ansi: true },
      20_000,
      socketForSession(hit.session),
    );
    const read = response.read ?? response;
    return Response.json(
      { text: read.text ?? "", truncated: read.truncated ?? false, revision: read.revision ?? null },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}

/** herdr wraps read payloads: `{type: "pane_read", read: {...}}`. */
type PaneReadResponse = {
  read?: { text?: string; truncated?: boolean; revision?: number };
  text?: string;
  truncated?: boolean;
  revision?: number;
};
