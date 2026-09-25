import { readAgentChat } from "@/lib/chat";
import { findPane } from "@/lib/herdr/panes";
import { sessionFromRequest } from "@/lib/herdr/request";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const paneId = url.searchParams.get("pane") ?? "";
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 250) || 250, 20), 1000);
  const requested = sessionFromRequest(request);

  const hit = await findPane(paneId, requested);
  if (!hit) {
    return Response.json({ error: `unknown pane ${paneId}`, session: requested }, { status: 404 });
  }

  const session = readAgentChat(hit.pane, limit);
  return Response.json({ ...session, session: hit.session }, { headers: { "cache-control": "no-store" } });
}
