import net from "node:net";
import { SOCKET_PATH } from "./rpc";

export type PushEvent = { type: string; data: Record<string, unknown> };

/**
 * Long-lived event subscription.
 *
 * A subscription is the one herdr request that keeps its connection open: send
 * `events.subscribe` once, then only read. Any other request on this connection
 * ends the stream, which is why requests run on their own connections.
 */
export class HerdrStream {
  private sock: net.Socket | null = null;
  private buffer = "";
  private tries = 0;
  private connecting = false;
  private lastUpAt = 0;
  private closing = false;
  private pushHandlers = new Set<(event: PushEvent) => void>();

  connected = false;
  reconnects = 0;
  lastError: string | null = null;
  private subscriptions: string[] | null = null;

  /** Streams are per session: each herdr session has its own socket. */
  constructor(
    readonly label = "stream",
    private readonly socketPath: string = SOCKET_PATH,
  ) {}

  private log(message: string): void {
    if (process.env.AGENTBOARD_DEBUG_SOCKET) console.log(`[herdr:${this.label}] ${message}`);
  }

  ensure(): void {
    if (this.closing || this.sock || this.connecting) return;
    this.connecting = true;
    const sock = net.createConnection({ path: this.socketPath });
    sock.setEncoding("utf8");
    this.sock = sock;

    sock.on("connect", () => {
      this.connecting = false;
      this.log(`open (${this.reconnects} reconnects)`);
      this.tries = Date.now() - this.lastUpAt < 5000 ? this.tries + 1 : 0;
      this.lastUpAt = Date.now();
      this.connected = true;
      this.lastError = null;
      this.writeSubscription();
    });

    sock.on("data", (chunk: string) => this.ingest(chunk));

    sock.on("error", (err: Error) => {
      this.lastError = err.message;
      this.log(`error: ${err.message}`);
    });

    sock.on("close", () => {
      this.connecting = false;
      this.sock = null;
      const wasUp = this.connected;
      this.connected = false;
      if (wasUp) this.reconnects += 1;
      this.log(`closed${this.closing ? " (local)" : ""}`);
      if (this.closing) return;
      const delay = Math.min(500 * 2 ** this.tries++, 5000);
      setTimeout(() => this.ensure(), delay).unref?.();
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (typeof message.type !== "string") continue;
      if (message.type === "subscription_started") continue;
      const event = { type: message.type, data: (message.data ?? {}) as Record<string, unknown> };
      for (const handler of this.pushHandlers) handler(event);
    }
  }

  /** Sends the subscribe request; events are delivered to `onPush` afterwards. */
  subscribe(types: string[]): void {
    this.subscriptions = types;
    this.ensure();
    if (this.connected) this.writeSubscription();
  }

  /** Re-sent on every reconnect: a fresh connection carries no subscription. */
  private writeSubscription(): void {
    const sock = this.sock;
    if (!sock || !this.subscriptions) return;
    sock.write(
      `${JSON.stringify({
        id: "ab:sub",
        method: "events.subscribe",
        params: { subscriptions: this.subscriptions.map((type) => ({ type })) },
      })}\n`,
    );
  }

  onPush(handler: (event: PushEvent) => void): () => void {
    this.pushHandlers.add(handler);
    return () => this.pushHandlers.delete(handler);
  }

  close(): void {
    this.closing = true;
    const sock = this.sock;
    this.sock = null;
    this.connected = false;
    sock?.destroy();
  }
}
