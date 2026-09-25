import { board } from "@/lib/herdr/board";
import { sessionFromRequest } from "@/lib/herdr/request";
import { listSessions, sessionRescanRequested } from "@/lib/herdr/sessions";

export const dynamic = "force-dynamic";

const ALL_TICK_MS = 700;
const SESSION_RESCAN_MS = 10_000;

type Entry = { id: string; label: string; alive: boolean };

/**
 * Live board state over SSE.
 *
 * `scope=all` federates every herdr session into one document, so the fleet can show
 * all of them at once; the default scope streams the single session the request names.
 */
export async function GET(request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const all = new URL(request.url).searchParams.get("scope") === "all";
  const session = sessionFromRequest(request);
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* client vanished between frames */
        }
      };
      send("retry: 2000\n\n");

      if (!all) {
        const live = board(session);
        const frame = (state: unknown) => send(`data: ${JSON.stringify(state)}\n\n`);
        frame(live.getState());
        const unsubscribe = live.subscribe(frame);
        const keepAlive = setInterval(() => send(": keep-alive\n\n"), 25_000);
        keepAlive.unref?.();
        stop = () => {
          unsubscribe();
          clearInterval(keepAlive);
        };
        request.signal.addEventListener("abort", stop);
        return;
      }

      let entries: Entry[] = [];
      let signature = "";
      let scanStarted = 0;

      const scan = async () => {
        scanStarted = Date.now();
        try {
          // Dead sessions stay in the picker, not in the fleet.
          entries = (await listSessions())
            .filter((entry) => entry.alive || board(entry.id).getState().panes.length > 0)
            .map(({ id, label, alive }) => ({ id, label, alive }));
        } catch {
          /* keep the previous list */
        }
      };

      const tick = () => {
        // A freshly created session should show up immediately, not on the next interval.
        if (Date.now() - scanStarted > SESSION_RESCAN_MS || sessionRescanRequested() > scanStarted) void scan();
        const sessions = entries.map((entry) => {
          const state = board(entry.id).getState();
          return { ...entry, state };
        });
        const next = sessions.map((entry) => `${entry.id}:${entry.state.rev}`).join("|");
        if (next === signature) return;
        signature = next;
        send(`data: ${JSON.stringify({ scope: "all", sessions })}\n\n`);
      };

      void scan().then(tick);
      const timer = setInterval(tick, ALL_TICK_MS);
      timer.unref?.();
      const keepAlive = setInterval(() => send(": keep-alive\n\n"), 25_000);
      keepAlive.unref?.();
      stop = () => {
        clearInterval(timer);
        clearInterval(keepAlive);
      };
      request.signal.addEventListener("abort", stop);
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
