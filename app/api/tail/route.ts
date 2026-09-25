import { resolveTranscript } from "@/lib/chat";
import { watchFile } from "@/lib/chat/watch";
import { board } from "@/lib/herdr/board";
import { sessionFromRequest } from "@/lib/herdr/request";

export const dynamic = "force-dynamic";

/**
 * Pushes a tick whenever a pane's transcript file changes, so the chat view can
 * refetch immediately instead of waiting for its fallback poll.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const paneId = url.searchParams.get("pane") ?? "";
  const session = sessionFromRequest(request);
  const encoder = new TextEncoder();
  let dispose = () => {};
  let retry: NodeJS.Timeout | number | null = null;
  let keepAlive: NodeJS.Timeout | number | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          /* client gone */
        }
      };
      send("retry: 2000\n\n");

      const attach = (): boolean => {
        const pane = board(session)
          .getState()
          .panes.find((candidate) => candidate.pane_id === paneId);
        if (!pane) {
          send(`event: gone\ndata: ${JSON.stringify({ pane: paneId })}\n\n`);
          return true;
        }
        const target = resolveTranscript(pane);
        if (!target.path) return false;
        send(`event: ready\ndata: ${JSON.stringify({ kind: target.kind, path: target.path })}\n\n`);
        dispose = watchFile(target.path, () => send(`data: ${JSON.stringify({ pane: paneId, at: Date.now() })}\n\n`));
        return true;
      };

      if (!attach()) {
        retry = setInterval(() => {
          if (attach() && retry) {
            clearInterval(retry);
            retry = null;
          }
        }, 1500);
        retry.unref?.();
      }
      keepAlive = setInterval(() => send(": keep-alive\n\n"), 25000);
      keepAlive.unref?.();
    },
    cancel() {
      dispose();
      clearInterval(retry ?? undefined);
      clearInterval(keepAlive ?? undefined);
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
