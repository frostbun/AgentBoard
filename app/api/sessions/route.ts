import { createSession, deleteSession, listSessions, stopSession } from "@/lib/herdr/sessions";

export const dynamic = "force-dynamic";

/** Every herdr session herdr knows about, pinged for liveness. */
export async function GET(): Promise<Response> {
  return Response.json({ sessions: await listSessions() }, { headers: { "cache-control": "no-store" } });
}

/** Stop a session's server, or delete the session outright. */
export async function DELETE(request: Request): Promise<Response> {
  let body: { name?: unknown; remove?: unknown };
  try {
    body = (await request.json()) as { name?: unknown; remove?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const result = body.remove === true ? await deleteSession(name) : await stopSession(name);
  if ("error" in result) return Response.json(result, { status: 400 });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

/** Start a named session (creates it when it does not exist yet). */
export async function POST(request: Request): Promise<Response> {
  let body: { name?: unknown };
  try {
    body = (await request.json()) as { name?: unknown };
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const result = await createSession(name);
  if ("error" in result) return Response.json(result, { status: 400 });
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
