import { board } from "@/lib/herdr/board";
import { sessionFromRequest } from "@/lib/herdr/request";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return Response.json(board(sessionFromRequest(request)).getState(), { headers: { "cache-control": "no-store" } });
}
