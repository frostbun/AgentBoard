export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export type AgentSessionRef = {
  source: string;
  agent: string;
  kind: "id" | "path";
  value: string;
};

export type ScrollInfo = {
  offset_from_bottom: number;
  max_offset_from_bottom: number;
  viewport_rows: number;
};

export type PaneInfo = {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  terminal_id: string;
  focused: boolean;
  revision: number;
  agent?: string | null;
  agent_status: AgentStatus;
  agent_session?: AgentSessionRef;
  display_agent?: string | null;
  title?: string | null;
  label?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  cwd?: string | null;
  foreground_cwd?: string | null;
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  scroll?: ScrollInfo;
};

export type AgentInfo = PaneInfo & {
  name?: string | null;
  state_change_seq?: number;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  screen_detection_skipped?: boolean;
};

export type WorkspaceWorktree = {
  group_id?: string;
  branch?: string;
  path?: string;
  is_primary?: boolean;
  [key: string]: unknown;
};

export type WorkspaceInfo = {
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  active_tab_id: string;
  tab_count: number;
  pane_count: number;
  agent_status: AgentStatus;
  tokens?: Record<string, string>;
  worktree?: WorkspaceWorktree;
};

export type TabInfo = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label: string;
  focused: boolean;
  pane_count: number;
  agent_status: AgentStatus;
};

export type Snapshot = {
  version: string;
  protocol: number;
  focused_workspace_id?: string;
  focused_tab_id?: string;
  focused_pane_id?: string;
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  layouts?: unknown[];
};

export type AttentionItem = {
  pane_id: string;
  workspace_id: string;
  status: Extract<AgentStatus, "blocked" | "done">;
  agent: string | null;
  title: string | null;
  cwd: string | null;
  workspace_label: string;
  tab_label: string;
  first_seen: number;
};

export type BoardPane = PaneInfo & {
  workspace_label: string;
  tab_label: string;
};

export type LinkStatus = {
  connected: boolean;
  error: string | null;
  reconnects: number;
};

export type BoardState = {
  rev: number;
  connected: boolean;
  error: string | null;
  /** The herdr session this state mirrors; the client shows it and offers switching. */
  session: string;
  socket: string;
  link: { stream: LinkStatus; last_ok_at: number | null };
  herdr: { version: string | null; protocol: number | null };
  focused: { workspace_id: string | null; tab_id: string | null; pane_id: string | null };
  workspaces: WorkspaceInfo[];
  tabs: TabInfo[];
  panes: BoardPane[];
  agents: AgentInfo[];
  attention: AttentionItem[];
  updated_at: number;
};

export const STATUS_ORDER: Record<AgentStatus, number> = {
  blocked: 0,
  done: 1,
  working: 2,
  idle: 3,
  unknown: 4,
};

/** Braille/ASCII spinners that agent TUIs prepend to their terminal title. */
const SPINNER = /[\u2800-\u28FF\u25D0-\u25D3\u25E2-\u25E5]/g;

export function stripSpinner(text: string): string {
  return text.replace(SPINNER, "").replace(/\s{2,}/g, " ").trim();
}

/**
 * Why closing this agent needs a confirmation, or null when it can go straight away.
 * An idle agent has finished and been seen; anything else is work in flight or unreviewed.
 */
export function closeWarning(status: AgentStatus): string | null {
  switch (status) {
    case "idle":
      return null;
    case "working":
      return "is still working";
    case "blocked":
      return "is waiting for your answer";
    case "done":
      return "finished but has not been reviewed";
    default:
      return "has an unknown state";
  }
}

/** Tab titles are produced from the pane titles of herdr agents. */
export function paneTitle(pane: {
  title?: string | null;
  terminal_title_stripped?: string | null;
  terminal_title?: string | null;
  label?: string | null;
}): string | null {
  const raw =
    pane.title?.trim() ||
    pane.label?.trim() ||
    pane.terminal_title_stripped?.trim() ||
    pane.terminal_title?.trim() ||
    null;
  if (!raw) return null;
  const clean = stripSpinner(raw);
  return clean.length ? clean : null;
}
