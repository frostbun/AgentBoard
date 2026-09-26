import { DEFAULT_SESSION } from "./board";
import { sessionExists, sessionSocket } from "./sessions";

/** Session id from `?session=`, falling back to the board's own resolved session. */
export function sessionFromRequest(request: Request): string {
  const value = new URL(request.url).searchParams.get("session");
  return value?.trim() || DEFAULT_SESSION;
}

export function sessionFromBody(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_SESSION;
}

export function socketForSession(sessionId: string): string {
  return sessionSocket(sessionId);
}

/** The 400 to answer with when no herdr session answers to this id, or null. */
export function unknownSession(session: string): Response | null {
  if (sessionExists(session)) return null;
  return Response.json({ error: `unknown session "${session}"` }, { status: 400 });
}
