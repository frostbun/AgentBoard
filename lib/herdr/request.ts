import { DEFAULT_SESSION } from "./board";
import { sessionSocket } from "./sessions";

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
