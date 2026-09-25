import { board } from "./board";
import { listSessions } from "./sessions";
import type { BoardPane } from "./types";

export type PaneHit = { session: string; pane: BoardPane };

let sessionCache: { at: number; ids: string[] } = { at: 0, ids: [] };

async function allSessionIds(): Promise<string[]> {
  if (Date.now() - sessionCache.at < 10_000) return sessionCache.ids;
  try {
    const ids = (await listSessions())
      .filter((entry) => entry.alive)
      .map((entry) => entry.id);
    sessionCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return sessionCache.ids;
  }
}

/**
 * Locate a pane, falling back to every other session.
 *
 * Pane ids are only unique within a session, so a link that lost (or guessed wrong about)
 * its session would otherwise 404 even though the pane is right there. On a miss we refresh
 * the other boards — cold ones have not polled yet — and report which session actually owns
 * the pane so the caller can correct itself.
 */
export async function findPane(paneId: string, session: string): Promise<PaneHit | null> {
  if (!paneId) return null;

  const direct = board(session).getState().panes.find((pane) => pane.pane_id === paneId);
  if (direct) return { session, pane: direct };

  const others = (await allSessionIds()).filter((id) => id !== session);
  for (const id of others) {
    const pane = board(id).getState().panes.find((candidate) => candidate.pane_id === paneId);
    if (pane) return { session: id, pane };
  }
  // Nothing warm: ask each session once, then look again.
  for (const id of others) {
    try {
      await board(id).refresh();
    } catch {
      continue;
    }
    const pane = board(id).getState().panes.find((candidate) => candidate.pane_id === paneId);
    if (pane) return { session: id, pane };
  }
  return null;
}
