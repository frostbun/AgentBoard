import { SOCKET_PATH, herdrRequest } from "./rpc";
import { sessionExists, sessionIdForSocket, sessionSocket } from "./sessions";
import { HerdrStream, type PushEvent } from "./stream";
import {
  paneTitle,
  type AgentInfo,
  type AttentionItem,
  type BoardPane,
  type BoardState,
  type Snapshot,
  type TabInfo,
  type WorkspaceInfo,
} from "./types";

/** Events worth an immediate refresh. `pane_updated` fires on status/title changes
 *  (several times a second while a spinner runs), so refreshes are coalesced. */
const TRIGGERS = new Set([
  "workspace_created",
  "workspace_updated",
  "workspace_closed",
  "workspace_renamed",
  "workspace_moved",
  "workspace_reordered",
  "workspace_focused",
  "worktree_created",
  "worktree_opened",
  "worktree_removed",
  "tab_created",
  "tab_closed",
  "tab_renamed",
  "tab_moved",
  "tab_focused",
  "pane_created",
  "pane_closed",
  "pane_moved",
  "pane_focused",
  "pane_exited",
  "pane_agent_detected",
  "pane_updated",
]);

const SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.closed",
  "workspace.renamed",
  "workspace.moved",
  "workspace.reordered",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.renamed",
  "tab.moved",
  "tab.focused",
  "pane.created",
  "pane.closed",
  "pane.moved",
  "pane.focused",
  "pane.exited",
  "pane.agent_detected",
  "pane.updated",
];

const POLL_MS = 5000;
const SNAPSHOT_TIMEOUT_MS = 8000;
const MIN_REFRESH_GAP_MS = 1000;

/**
 * Bump when `BoardState` changes shape. Turbopack bundles this module once per
 * route, so class identity differs per bundle and must not be used to detect a
 * stale cached instance.
 */
const BOARD_BUILD = "9";

/**
 * Live mirror of the herdr session. Snapshot polling keeps state authoritative;
 * the event stream only makes it faster, so a dropped stream degrades latency
 * rather than correctness.
 */
export class Board {
  readonly build = BOARD_BUILD;
  private stream: HerdrStream;

  /** Each herdr session is mirrored by its own Board over its own socket. */
  constructor(
    readonly sessionId: string = sessionIdForSocket(SOCKET_PATH),
    private readonly socketPath: string = SOCKET_PATH,
  ) {
    this.stream = new HerdrStream(`board:${sessionId}`, socketPath);
    this.state = {
      rev: 0,
      connected: false,
      error: null,
      session: sessionId,
      socket: socketPath,
      link: {
        stream: { connected: false, error: null, reconnects: 0 },
        last_ok_at: null,
      },
      herdr: { version: null, protocol: null },
      focused: { workspace_id: null, tab_id: null, pane_id: null },
      workspaces: [],
      tabs: [],
      panes: [],
      agents: [],
      attention: [],
      updated_at: Date.now(),
    };
  }
  private subscribers = new Set<(state: BoardState) => void>();
  private attention = new Map<string, AttentionItem>();
  /** pane_id → signature of the last observed status/title, with when it changed. */
  private activity = new Map<string, { signature: string; at: number }>();
  private refreshTimer: NodeJS.Timeout | number | null = null;
  private pollTimer: NodeJS.Timeout | number | null = null;
  private refreshing = false;
  private lastRefreshStart = 0;
  private lastOkAt: number | null = null;
  private revision = 0;

  private state: BoardState;

  start(): void {
    if (this.pollTimer) return;
    this.stream.onPush((event: PushEvent) => {
      if (TRIGGERS.has(event.type)) this.scheduleRefresh(300);
    });
    this.stream.subscribe(SUBSCRIPTIONS);
    this.pollTimer = setInterval(() => void this.refresh(), POLL_MS);
    this.pollTimer.unref?.();
    void this.refresh();
  }

  scheduleRefresh(delayMs: number): void {
    if (this.refreshTimer) return;
    const wait = Math.max(delayMs, MIN_REFRESH_GAP_MS - (Date.now() - this.lastRefreshStart));
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, wait);
    this.refreshTimer.unref?.();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.lastRefreshStart = Date.now();
    try {
      const response = await herdrRequest<Snapshot | { snapshot: Snapshot }>("session.snapshot", {}, SNAPSHOT_TIMEOUT_MS, this.socketPath);
      const snapshot = "snapshot" in response && response.snapshot ? response.snapshot : (response as Snapshot);
      this.lastOkAt = Date.now();
      this.install(snapshot);
    } catch (err) {
      const message = (err as Error).message;
      // A session whose server is gone must not keep serving its last known panes.
      const dead = /ENOENT|ECONNREFUSED|server_not_running|no herdr server/i.test(message);
      if (dead) {
        this.attention.clear();
        this.state = {
          ...this.state,
          workspaces: [],
          tabs: [],
          panes: [],
          agents: [],
          attention: [],
        };
      }
      this.patch({ error: message, connected: false, link: this.link() });
    } finally {
      this.refreshing = false;
    }
  }

  private link(): BoardState["link"] {
    return {
      stream: {
        connected: this.stream.connected,
        error: this.stream.lastError,
        reconnects: this.stream.reconnects,
      },
      last_ok_at: this.lastOkAt,
    };
  }

  private install(snap: Snapshot): void {
    const workspaces: WorkspaceInfo[] = snap.workspaces ?? [];
    const tabs: TabInfo[] = snap.tabs ?? [];
    const workspaceLabel = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace.label]));
    const tabLabel = new Map(tabs.map((tab) => [tab.tab_id, tab.label]));
    const panes: BoardPane[] = (snap.panes ?? []).map((pane) => ({
      ...pane,
      workspace_label: workspaceLabel.get(pane.workspace_id) ?? pane.workspace_id,
      tab_label: tabLabel.get(pane.tab_id) ?? pane.tab_id,
    }));
    const agents: AgentInfo[] = snap.agents ?? [];

    const now = Date.now();
    const liveKeys = new Set(panes.map((pane) => pane.pane_id));
    for (const paneId of [...this.activity.keys()]) {
      if (!liveKeys.has(paneId)) this.activity.delete(paneId);
    }
    const withActivity: BoardPane[] = panes.map((pane) => {
      const signature = `${pane.agent_status}|${paneTitle(pane) ?? ""}`;
      const previous = this.activity.get(pane.pane_id);
      const at = previous && previous.signature === signature ? previous.at : now;
      this.activity.set(pane.pane_id, { signature, at });
      return { ...pane, last_change_at: at };
    });

    const live = new Set(panes.map((pane) => pane.pane_id));
    for (const [paneId, item] of this.attention) {
      const pane = panes.find((candidate) => candidate.pane_id === paneId);
      const stillWaiting = pane && (pane.agent_status === "blocked" || pane.agent_status === "done");
      if (!live.has(paneId) || !stillWaiting || pane?.agent_status !== item.status) this.attention.delete(paneId);
    }
    for (const pane of panes) {
      const status = pane.agent_status;
      if (!pane.agent || (status !== "blocked" && status !== "done")) continue;
      if (this.attention.has(pane.pane_id)) continue;
      this.attention.set(pane.pane_id, {
        pane_id: pane.pane_id,
        workspace_id: pane.workspace_id,
        status,
        agent: pane.display_agent ?? pane.agent ?? null,
        title: paneTitle(pane),
        cwd: pane.foreground_cwd ?? pane.cwd ?? null,
        workspace_label: pane.workspace_label,
        tab_label: pane.tab_label,
        first_seen: Date.now(),
      });
    }

    this.state = {
      rev: ++this.revision,
      connected: true,
      error: null,
      session: this.sessionId,
      socket: this.socketPath,
      link: this.link(),
      herdr: { version: snap.version ?? null, protocol: snap.protocol ?? null },
      focused: {
        workspace_id: snap.focused_workspace_id ?? null,
        tab_id: snap.focused_tab_id ?? null,
        pane_id: snap.focused_pane_id ?? null,
      },
      workspaces,
      tabs,
      panes: withActivity,
      agents,
      attention: [...this.attention.values()].sort((a, b) => b.first_seen - a.first_seen),
      updated_at: Date.now(),
    };
    this.emit();
  }

  private patch(partial: Partial<BoardState>): void {
    this.state = { ...this.state, ...partial, rev: ++this.revision, updated_at: Date.now() };
    this.emit();
  }

  private emit(): void {
    for (const cb of this.subscribers) {
      try {
        cb(this.state);
      } catch {
        /* a dead SSE writer must not stall the board */
      }
    }
  }

  getState(): BoardState {
    return this.state;
  }

  subscribe(cb: (state: BoardState) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  /** Releases timers and sockets; used when a newer build replaces this instance. */
  stop(): void {
    clearTimeout(this.refreshTimer ?? undefined);
    clearInterval(this.pollTimer ?? undefined);
    this.refreshTimer = null;
    this.pollTimer = null;
    this.subscribers.clear();
    this.stream.close();
  }
}

const GLOBAL_KEY = "__agentboard_boards__";
type CachedBoard = { build?: string; stop?: () => void };
type BoardGlobal = typeof globalThis & { [GLOBAL_KEY]?: Map<string, Board> };

export const DEFAULT_SESSION = sessionIdForSocket(SOCKET_PATH);

/**
 * Board for one herdr session, created on first use and reused for the process
 * lifetime. Survives Next.js dev HMR: instances from an older build are stopped.
 */
export function board(sessionId: string = DEFAULT_SESSION): Board {
  const g = globalThis as BoardGlobal;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  const boards = g[GLOBAL_KEY];
  const existing = boards.get(sessionId) as CachedBoard | undefined;
  if (existing && existing.build !== BOARD_BUILD) {
    existing.stop?.();
    boards.delete(sessionId);
  }
  if (boards.has(sessionId)) return boards.get(sessionId)!;
  // The id arrives from the client: one that no session answers to must not mint a board, or a
  // run of made-up ids leaves a polling stream and a 5s snapshot timer behind for each of them.
  if (!sessionExists(sessionId)) return new Board(sessionId, "");
  const fresh = new Board(sessionId, sessionSocket(sessionId));
  boards.set(sessionId, fresh);
  fresh.start();
  return fresh;
}
