"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, ConfirmSheet, IconButton, iconClass, PromptSheet, Row, Screen, Sheet, StatusDot, TopBar } from "@/components/bits";
import {
  callAction,
  notificationHint,
  notificationState,
  requestNotificationPermission,
  sendNotification,
  shortCwd,
  timeAgo,
  useAlertSettings,
  useAllSessions,
  useAttentionAlerts,
  type NotificationState,
  type SessionSnapshot,
} from "@/components/use-board";
import type { SessionInfo } from "@/components/session-chip";
import { agentName, sessionId } from "@/lib/herdr/names";
import { closeWarning, paneTitle, type AttentionItem, type BoardPane, type WorkspaceInfo } from "@/lib/herdr/types";

type SessionAttention = AttentionItem & { session: string };

/** A destructive tap parked behind a sheet; `run` returns true when it asked a follow-up. */
type Asked = { title: string; body: string; label: string; run: () => Promise<boolean> };

/** Free-text match over everything a row shows, so one box searches agents and places. */
function matches(pane: BoardPane, session: SessionSnapshot, workspace: WorkspaceInfo, needle: string): boolean {
  if (!needle) return true;
  const haystack = [
    pane.agent,
    pane.display_agent,
    paneTitle(pane),
    pane.label,
    pane.pane_id,
    pane.foreground_cwd,
    pane.cwd,
    workspace.label,
    session.label,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** Does this workspace hold any pane the search box matches? */
function hasMatch(session: SessionSnapshot, workspace: WorkspaceInfo, needle: string): boolean {
  return session.state.panes.some(
    (pane) => pane.workspace_id === workspace.workspace_id && Boolean(pane.agent) && matches(pane, session, workspace, needle),
  );
}

function AttentionCard({ item, onReview }: { item: SessionAttention; onReview: (item: SessionAttention) => void }) {
  const href = `/a/${encodeURIComponent(item.pane_id)}?session=${encodeURIComponent(item.session)}`;
  return (
    <div className={`card mb-2 p-3 ${item.status === "blocked" ? "border-[var(--color-blocked)]/40" : "border-[var(--color-done)]/30"}`}>
      <div className="flex items-start gap-2">
        <StatusDot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <Link href={href} className="truncate text-sm font-semibold text-white">
              {item.agent ?? "agent"}
            </Link>
            <span className="shrink-0 text-[0.7rem] text-ink-400">{timeAgo(item.first_seen)} ago</span>
          </div>
          <div className="truncate text-xs text-ink-200">{item.title ?? item.pane_id}</div>
          <div className="truncate text-[0.7rem] text-ink-400">
            {item.workspace_label} · {shortCwd(item.cwd)}
          </div>
        </div>
      </div>
      <div className="mt-2">
        <Button full tone={item.status === "blocked" ? "primary" : "default"} onClick={() => onReview(item)}>
          {item.status === "blocked" ? "Answer" : "Review"}
        </Button>
      </div>
    </div>
  );
}

function AgentRow({
  pane,
  session,
  agentName,
  activity,
  onRename,
  onClose,
}: {
  pane: BoardPane;
  session: SessionSnapshot;
  /** herdr keeps the renameable name on the agent record, not on the pane. */
  agentName: string | null;
  activity: number | undefined;
  onRename: (pane: BoardPane, session: string) => void;
  onClose: (pane: BoardPane, session: string) => void;
}) {
  return (
    <div className="flex items-center gap-1 border-b border-ink-850 pr-2 last:border-0">
      <Link
        href={`/a/${encodeURIComponent(pane.pane_id)}?session=${encodeURIComponent(session.id)}`}
        className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 active:bg-ink-900"
      >
        <StatusDot status={pane.agent_status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm text-white">{pane.display_agent ?? agentName ?? pane.agent ?? pane.label ?? "shell"}</span>
            <span className="shrink-0 text-[0.65rem] text-ink-400">{pane.pane_id}</span>
          </div>
          <div className="truncate text-[0.75rem] text-ink-200">{paneTitle(pane) ?? pane.pane_id}</div>
          <div className="truncate text-[0.68rem] text-ink-400">{shortCwd(pane.foreground_cwd ?? pane.cwd)}</div>
        </div>
        {activity ? <span className="shrink-0 text-[0.65rem] text-ink-400">{timeAgo(activity)}</span> : null}
      </Link>
      <IconButton label="Rename this agent" onClick={() => onRename(pane, session.id)}>
        ✎
      </IconButton>
      <IconButton label="Close this agent" onClick={() => onClose(pane, session.id)}>
        ✕
      </IconButton>
    </div>
  );
}

function WorkspaceCard({
  workspace,
  session,
  needle,
  onRename,
  onClose,
  onResume,
  onCloseWorkspace,
}: {
  workspace: WorkspaceInfo;
  session: SessionSnapshot;
  needle: string;
  onRename: (pane: BoardPane, session: string) => void;
  onClose: (pane: BoardPane, session: string) => void;
  onResume: (workspace: WorkspaceInfo, session: string) => void;
  onCloseWorkspace: (workspace: WorkspaceInfo, session: string) => void;
}) {
  const panes = session.state.panes.filter(
    (pane) => pane.workspace_id === workspace.workspace_id && Boolean(pane.agent) && matches(pane, session, workspace, needle),
  );
  const agentCount = panes.filter((pane) => pane.agent).length;

  return (
    <div className="mb-2">
      <div className="mb-1 flex items-center gap-2 px-1">
        <h3 className="min-w-0 truncate text-sm font-semibold text-white">
          {workspace.number}. {workspace.label}
        </h3>
        {workspace.worktree?.branch ? (
          <span className="shrink-0 rounded-full border border-ink-700 px-2 py-0.5 text-[0.6rem] text-ink-400">
            ⑂ {String(workspace.worktree.branch)}
          </span>
        ) : null}
        <span className="shrink-0 text-[0.65rem] text-ink-400">
          {agentCount} agent{agentCount === 1 ? "" : "s"}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <StatusDot status={workspace.agent_status} />
          <IconButton label={`Close ${workspace.label}`} onClick={() => onCloseWorkspace(workspace, session.id)}>
            ✕
          </IconButton>
          <IconButton label={`Resume an agent in ${workspace.label}`} onClick={() => onResume(workspace, session.id)}>
            ↻
          </IconButton>
          <Link
            href={`/new?session=${encodeURIComponent(session.id)}&workspace=${encodeURIComponent(workspace.workspace_id)}`}
            className={iconClass()}
            title={`New agent in ${workspace.label}`}
          >
            +
          </Link>
        </span>
      </div>

      {panes.length === 0 ? (
        <div className="card px-3 py-2 text-[0.7rem] text-ink-400">
          {needle ? "no agent matches here" : "no agents yet"}
        </div>
      ) : (
        <div className="card divide-y divide-ink-850">
          {panes.map((pane) => (
            <AgentRow
              key={pane.pane_id}
              pane={pane}
              session={session}
              agentName={session.state.agents.find((agent) => agent.pane_id === pane.pane_id)?.name ?? null}
              activity={pane.last_change_at}
              onRename={onRename}
              onClose={onClose}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function FleetPage() {
  const router = useRouter();
  const { sessions, ready } = useAllSessions();
  const { muted, toggle } = useAlertSettings();
  const [needle, setNeedle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sessionSheet, setSessionSheet] = useState(false);
  const [newSession, setNewSession] = useState("");
  const [known, setKnown] = useState<SessionInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ name: string; label: string } | null>(null);
  const [workspaceSheet, setWorkspaceSheet] = useState<string | null>(null);
  const [workspaceLabel, setWorkspaceLabel] = useState("");
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [home, setHome] = useState("");
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState<Asked | null>(null);
  const [asking, setAsking] = useState(false);
  /** The pane being renamed: null closed, otherwise the pane, its session and the draft name. */
  const [rename, setRename] = useState<{ pane: BoardPane; session: string; value: string } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<{
    workspace: WorkspaceInfo;
    session: string;
    /** Every agent pane in the workspace, newest first — each one is a resumable session. */
    candidates: { pane: BoardPane; title: string | null }[];
    paneId: string;
  } | null>(null);
  const [resumeModel, setResumeModel] = useState("");
  const [resumeModels, setResumeModels] = useState<string[]>([]);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [permission, setPermission] = useState<NotificationState>("default");
  const [testSent, setTestSent] = useState<string | null>(null);


  const attention: SessionAttention[] = useMemo(
    () => sessions.flatMap((entry) => entry.state.attention.map((item) => ({ ...item, session: entry.id }))),
    [sessions],
  );
  const agentCount = sessions.reduce(
    (total, entry) => total + entry.state.panes.filter((pane) => pane.agent && matches(pane, entry, { label: "" } as WorkspaceInfo, needle)).length,
    0,
  );
  const filtered = Boolean(needle.trim());

  useEffect(() => setPermission(notificationState()), [notifyOpen]);
  useEffect(() => {
    if (!sessionSheet) return;
    setSessionError(null);
    fetch("/api/sessions", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { sessions: SessionInfo[] }) => setKnown(payload.sessions))
      .catch(() => setSessionError("could not list sessions"));
  }, [sessionSheet]);
  useAttentionAlerts(attention, muted);

  useEffect(() => {
    if (home) return;
    fetch("/api/agents", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { home?: string }) => {
        if (payload.home) {
          setHome(payload.home);
          setWorkspaceCwd((current) => current || payload.home!);
        }
      })
      .catch(() => undefined);
  }, [home]);

  const openWorkspaceSheet = (sessionId: string) => {
    setSessionError(null);
    setWorkspaceLabel("");
    setWorkspaceSheet(sessionId);
  };

  const createWorkspace = async () => {
    const sessionId = workspaceSheet;
    if (!sessionId) return;
    setBusy(true);
    setSessionError(null);
    try {
      const label = workspaceLabel.trim();
      const cwd = workspaceCwd.trim();
      if (!cwd) throw new Error("a directory is required");
      const response = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "workspace.create",
          params: { cwd, ...(label ? { label } : {}), focus: false },
          session: sessionId,
        }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setWorkspaceSheet(null);
    } catch (err) {
      setSessionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** herdr keeps the renameable name on the agent record; the ask is our sheet, not window.prompt. */
  const openRename = (pane: BoardPane, sessionId: string) => {
    setError(null);
    setRename({ pane, session: sessionId, value: pane.display_agent ?? pane.agent ?? "" });
  };

  const submitRename = async () => {
    const target = rename;
    if (!target) return;
    const typed = target.value.trim();
    if (!typed) return;
    setRenaming(true);
    setError(null);
    try {
      await callAction(
        "agent.rename",
        { target: target.pane.pane_id, name: agentName(typed, target.pane.agent ?? "agent") },
        30_000,
        target.session,
      );
      setRename(null);
    } catch (err) {
      const message = (err as Error).message;
      setRename(null);
      setError(
        /launch_pending/i.test(message)
          ? "herdr refuses to rename while the agent is still starting — try again in a moment"
          : message,
      );
    } finally {
      setRenaming(false);
    }
  };

  /**
   * Closing kills the agent with the pane. An idle agent is finished and seen, so it goes
   * straight away; anything else — working, blocked, or finished but not yet reviewed — asks
   * first and says which it is. The ask is one of our sheets: the browser's own confirm is a
   * no-op in the installed iOS web app this board is read in, which looks like a dead button.
   */
  const closeAgent = (pane: BoardPane, sessionId: string) => {
    const label = pane.display_agent ?? pane.agent ?? pane.pane_id;
    const warning = closeWarning(pane.agent_status);
    setError(null);
    const close = async () => {
      await callAction("pane.close", { pane_id: pane.pane_id }, 20_000, sessionId);
      return false;
    };
    if (!warning) {
      void close().catch((err) => setError((err as Error).message));
      return;
    }
    setAsked({
      title: `Close ${label}`,
      body: `${pane.pane_id}: it ${warning}, and closing kills the agent.`,
      label: "Close pane",
      run: close,
    });
  };

  const loadResumeModels = (kind: string | null | undefined) => {
    setResumeModels([]);
    if (!kind) return;
    fetch(`/api/models?kind=${encodeURIComponent(kind)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { models?: string[] }) => setResumeModels(payload.models ?? []))
      .catch(() => setResumeModels([]));
  };

  /** Opens the resume sheet: every agent pane in the workspace is one resumable session. */
  const openResume = (workspace: WorkspaceInfo, sessionId: string) => {
    setError(null);
    setResumeModel("");
    const state = sessions.find((entry) => entry.id === sessionId)?.state;
    const panes = (state?.panes ?? [])
      .filter((pane) => pane.workspace_id === workspace.workspace_id && pane.agent)
      .sort((a, b) => (b.revision ?? 0) - (a.revision ?? 0));
    // Newest first, and the newest pane herdr actually named a session for wins the preselect:
    // an agent that never reported one cannot be continued.
    const preset = panes.find((pane) => pane.agent_session) ?? panes[0];
    setResumeTarget({
      workspace,
      session: sessionId,
      candidates: panes.map((pane) => ({ pane, title: paneTitle(pane) })),
      paneId: preset?.pane_id ?? "",
    });
    loadResumeModels(preset?.agent);
  };

  const pickResumePane = (pane: BoardPane) => {
    setResumeTarget((current) => (current ? { ...current, paneId: pane.pane_id } : current));
    loadResumeModels(pane.agent);
  };

  const resumeAgent = async () => {
    const target = resumeTarget;
    if (!target?.paneId) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/resume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session: target.session,
          workspace: target.workspace.workspace_id,
          pane: target.paneId,
          model: resumeModel || null,
        }),
      });
      const payload = (await response.json()) as { pane_id?: string; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setResumeTarget(null);
      if (payload.pane_id) router.push(`/a/${encodeURIComponent(payload.pane_id)}?session=${encodeURIComponent(target.session)}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Closing a workspace takes every pane with it, so the same rule as a pane applies. */
  const closeWorkspace = (workspace: WorkspaceInfo, sessionId: string) => {
    const panes = sessions.find((entry) => entry.id === sessionId)?.state.panes.filter((pane) => pane.workspace_id === workspace.workspace_id) ?? [];
    const busyPane = panes.find((pane) => closeWarning(pane.agent_status));
    setError(null);
    const close = (group: boolean) =>
      callAction("workspace.close", { workspace_id: workspace.workspace_id, ...(group ? { close_group: true } : {}) }, 30_000, sessionId);
    // herdr refuses to drop a primary workspace whose linked worktrees are still open.
    const run = async (group: boolean): Promise<boolean> => {
      try {
        await close(group);
        return false;
      } catch (err) {
        if (group || !/close_group|worktree/i.test((err as Error).message)) throw err;
        setAsked({
          title: `Close ${workspace.label}`,
          body: `It holds linked worktree workspaces. Closing them too takes every pane in them.`,
          label: "Close them too",
          run: () => run(true),
        });
        return true;
      }
    };
    if (!busyPane && panes.length) {
      void run(false).catch((err) => setError((err as Error).message));
      return;
    }
    setAsked({
      title: `Close ${workspace.label}`,
      body: busyPane
        ? `It holds an agent that ${closeWarning(busyPane.agent_status)}. Closing the workspace takes every pane in it.`
        : `It is empty. Closing it removes it from herdr.`,
      label: "Close workspace",
      run: () => run(false),
    });
  };

  /** Runs the parked action; a follow-up question left in its place keeps the sheet open. */
  const submit = async () => {
    const request = asked;
    if (!request) return;
    setAsking(true);
    setError(null);
    try {
      if (!(await request.run())) setAsked(null);
    } catch (err) {
      setError((err as Error).message);
      setAsked(null);
    } finally {
      setAsking(false);
    }
  };

  const changeSession = async (name: string, remove: boolean) => {
    setBusy(true);
    setSessionError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, remove }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setSessionSheet(false);
      setRemoveTarget(null);
    } catch (err) {
      setSessionError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startSession = async (name: string) => {
    setCreating(true);
    setSessionError(null);
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = (await response.json()) as { session?: SessionInfo; error?: string };
      if (!response.ok || payload.error) throw new Error(payload.error ?? `HTTP ${response.status}`);
      setNewSession("");
      setSessionSheet(false);
    } catch (err) {
      setSessionError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const askPermission = async () => setPermission(await requestNotificationPermission());
  const testNotification = () => {
    setTestSent(null);
    const ok = sendNotification("AgentBoard test", "If you can read this, blocked/done alerts arrive here.", "agentboard-test");
    setTestSent(ok ? "sent — check your notification centre" : "browser refused: permission is not granted");
  };

  /**
   * Reviewing focuses the pane on the way in. Opening a chat is a read and leaves herdr's
   * "done, unseen" state alone, so the card would never clear; an explicit focus marks the
   * agent seen (and switches herdr to it, which is what you want when you act on it).
   */
  const review = async (item: SessionAttention) => {
    setError(null);
    try {
      await callAction("pane.focus", { pane_id: item.pane_id }, 10_000, item.session);
    } catch {
      /* navigate anyway: focus needs a running herdr, the chat view does not */
    }
    router.push(`/a/${encodeURIComponent(item.pane_id)}?session=${encodeURIComponent(item.session)}`);
  };

  const live = sessions.some((entry) => entry.state.connected);
  const resumeSelected = resumeTarget?.candidates.find((entry) => entry.pane.pane_id === resumeTarget.paneId) ?? null;
  const visibleAttention = filtered
    ? attention.filter((item) => `${item.agent} ${item.title} ${item.workspace_label}`.toLowerCase().includes(needle.toLowerCase()))
    : attention;

  return (
    <Screen>
      <TopBar
        title="AgentBoard"
        subtitle={
          ready
            ? `${agentCount} agent${agentCount === 1 ? "" : "s"} · ${sessions.length} session${sessions.length === 1 ? "" : "s"} · ${
                live ? "live" : "reconnecting"
              }`
            : "connecting…"
        }
        right={
          <div className="flex items-center gap-2">
            <IconButton
              label="Notification settings"
              tone={muted ? "default" : "accent"}
              onClick={() => setNotifyOpen(true)}
            >
              {muted ? "🔇" : permission === "granted" ? "🔔" : "🔕"}
            </IconButton>
            <span className={`inline-block h-2 w-2 rounded-full ${live ? "bg-[var(--color-done)]" : "bg-[var(--color-blocked)]"}`} />
          </div>
        }
      />

      <div className="border-b border-ink-850 px-3 pt-2 pb-2">
        <div className="flex items-center gap-2">
          <input
            value={needle}
            onChange={(event) => setNeedle(event.target.value)}
            placeholder="Search agents, titles, workspaces…"
            className="field min-w-0 flex-1"
          />
          {needle ? (
            <Button size="sm" onClick={() => setNeedle("")}>
              clear
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="mx-4 mt-2 rounded-lg border border-[var(--color-blocked)]/40 px-3 py-2 text-xs text-[var(--color-blocked)]">
          {error}
        </div>
      ) : null}

      <main className="scroll-y min-h-0 flex-1 pb-4">
        <section id="inbox" className="px-3 pt-3">
          <h2 className="mb-2 px-1 text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">
            Needs you {visibleAttention.length ? `(${visibleAttention.length})` : ""}
          </h2>
          {visibleAttention.length ? (
            visibleAttention.map((item) => (
              <AttentionCard key={`${item.session}:${item.pane_id}`} item={item} onReview={(target) => void review(target)} />
            ))
          ) : (
            <div className="card px-3 py-4 text-center text-xs text-ink-400">All agents are working. Nothing blocked.</div>
          )}
        </section>

        {sessions.map((session) => {
          const workspaces = session.state.workspaces;
          return (
            <section key={session.id} className="px-3 pt-4">
              <div className="mb-1 flex items-center gap-2 px-1">
                <h2 className="truncate text-[0.95rem] font-semibold text-[var(--color-accent)]">⇄ {session.label}</h2>
                <span className={`inline-block h-2 w-2 rounded-full ${session.alive ? "bg-[var(--color-done)]" : "bg-[var(--color-blocked)]"}`} />
                <span className="text-[0.65rem] text-ink-400">
                  {workspaces.length} workspace{workspaces.length === 1 ? "" : "s"}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  <IconButton
                    label={`Stop or delete ${session.label}`}
                    onClick={() => {
                      setSessionError(null);
                      setRemoveTarget({ name: session.id, label: session.label });
                    }}
                  >
                    ⏹
                  </IconButton>
                  <IconButton label={`New workspace in ${session.label}`} onClick={() => openWorkspaceSheet(session.id)}>
                    +
                  </IconButton>
                </span>
              </div>
              {workspaces.length === 0 ? (
                <button
                  type="button"
                  onClick={() => openWorkspaceSheet(session.id)}
                  className="card flex w-full items-center gap-2 px-3 py-3 text-left text-xs text-ink-200 active:bg-ink-900"
                >
                  <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg border border-ink-700 text-sm">+</span>
                  create the first workspace in this session
                </button>
              ) : (
                workspaces
                  .filter((workspace) => !filtered || hasMatch(session, workspace, needle))
                  .map((workspace) => (
                    <WorkspaceCard
                      key={`${session.id}:${workspace.workspace_id}`}
                      workspace={workspace}
                      session={session}
                      needle={needle}
                      onRename={openRename}
                      onClose={closeAgent}
                      onResume={openResume}
                      onCloseWorkspace={closeWorkspace}
                    />
                  ))
              )}
            </section>
          );
        })}

        {ready && sessions.length === 0 ? (
          <div className="px-3 pt-4 text-center text-xs text-ink-400">No herdr sessions found on this machine.</div>
        ) : null}

        <div className="px-3 pt-2">
          <Button full onClick={() => setSessionSheet(true)}>
            + New session
          </Button>
        </div>
      </main>

      <Sheet open={removeTarget !== null && asked === null} onClose={() => setRemoveTarget(null)} title={`${removeTarget?.label ?? ""} session`}>
        <div className="space-y-2">
          <Button
            full
            disabled={busy}
            onClick={() => void changeSession(removeTarget?.name ?? "", false)}
          >
            {busy ? "working…" : "Stop the server (keeps its history)"}
          </Button>
          <Button
            full
            tone="danger"
            disabled={busy || removeTarget?.name === "default"}
            onClick={() => {
              const target = removeTarget;
              if (!target) return;
              setAsked({
                title: `Delete ${target.label}`,
                body: `Its workspaces, transcripts and logs go away, and agents running in it are killed.`,
                label: "Delete the session",
                run: async () => {
                  await changeSession(target.name, true);
                  return false;
                },
              });
            }}
          >
            Delete the session
          </Button>
          <p className="text-[0.7rem] text-ink-400">
            Stopping leaves <code>~/.config/herdr/sessions/{removeTarget?.name}</code> in place so it can be started
            again. Deleting removes that directory; agents running in it are killed.
          </p>
          {sessionError ? <p className="text-[0.75rem] text-[var(--color-blocked)]">{sessionError}</p> : null}
        </div>
      </Sheet>

      <Sheet open={resumeTarget !== null} onClose={() => setResumeTarget(null)} title={`Resume in ${resumeTarget?.workspace.label ?? ""}`}>
        <div className="space-y-3">
          <p className="text-[0.75rem] text-ink-200">
            Pick the session to continue — it reopens in a new pane next to the original.
          </p>
          <div className="scroll-y max-h-[40dvh] space-y-2">
            {resumeTarget?.candidates.map(({ pane, title }) => (
              <Button
                key={pane.pane_id}
                full
                size="sm"
                tone={pane.pane_id === resumeTarget.paneId ? "accent" : "default"}
                onClick={() => pickResumePane(pane)}
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate">
                    {pane.display_agent ?? pane.agent} <span className="text-ink-400">{pane.pane_id}</span>
                  </span>
                  <span className="block truncate text-[0.75rem] text-ink-400">{title ?? pane.label ?? "untitled"}</span>
                  <span className="block truncate text-[0.7rem] text-ink-400">
                    {pane.agent_session
                      ? `session ${sessionId(pane.agent_session)}`
                      : "no session reference — herdr never got one from this agent"}
                  </span>
                </span>
              </Button>
            ))}
          </div>
          <select
            value={resumeModel}
            onChange={(event) => setResumeModel(event.target.value)}
            disabled={!resumeModels.length}
            className="field"
          >
            <option value="">model: as before</option>
            {resumeModels.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          {!resumeTarget?.candidates.length ? (
            <p className="text-[0.75rem] text-[var(--color-blocked)]">No agent in this workspace to continue.</p>
          ) : null}
          {resumeSelected && !resumeSelected.pane.agent_session ? (
            <p className="text-[0.75rem] text-[var(--color-blocked)]">
              herdr has no session reference for {resumeSelected.pane.pane_id} — this agent never reported one, so there is
              nothing to continue. Restart the agent (its integration reports a session when it starts) and retry.
            </p>
          ) : null}
          {resumeSelected?.pane.agent_session && !resumeModels.length ? (
            <p className="text-[0.75rem] text-ink-400">This agent has no model flag — it starts with its own default.</p>
          ) : null}
          {error ? <p className="text-[0.8rem] text-[var(--color-blocked)]">{error}</p> : null}
          <Button full tone="primary" disabled={!resumeSelected?.pane.agent_session || busy} onClick={() => void resumeAgent()}>
            {busy ? "resuming…" : "Resume"}
          </Button>
        </div>
      </Sheet>

      <Sheet open={workspaceSheet !== null} onClose={() => setWorkspaceSheet(null)} title={`New workspace in ${workspaceSheet ?? ""}`}>
        <div className="space-y-3">
          <input
            value={workspaceLabel}
            onChange={(event) => setWorkspaceLabel(event.target.value)}
            placeholder="name (e.g. api)"
            className="field"
          />
          <input
            value={workspaceCwd}
            onChange={(event) => setWorkspaceCwd(event.target.value)}
            placeholder="/path/to/project"
            className="field"
          />
          <Button full tone="primary" disabled={busy || !workspaceCwd.trim()} onClick={() => void createWorkspace()}>
            {busy ? "creating…" : "Create workspace"}
          </Button>
          {sessionError ? <p className="text-[0.75rem] text-[var(--color-blocked)]">{sessionError}</p> : null}
          <p className="text-[0.7rem] text-ink-400">
            Runs <code>workspace.create</code> on this session: a new herdr workspace with a shell pane in that
            directory. Add an agent to it with the workspace's <b>+</b>.
          </p>
        </div>
      </Sheet>

      <Sheet open={sessionSheet} onClose={() => setSessionSheet(false)} title="New session">
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              value={newSession}
              onChange={(event) => setNewSession(event.target.value.toLowerCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter" && newSession.trim() && !creating) void startSession(newSession.trim());
              }}
              placeholder="session name"
              className="field min-w-0 flex-1"
            />
            <Button tone="primary" disabled={creating || !newSession.trim()} onClick={() => void startSession(newSession.trim())}>
              {creating ? "starting…" : "Start"}
            </Button>
          </div>
          <p className="text-[0.7rem] text-ink-400">
            Runs <code>herdr --session NAME server</code> on this machine; the session appears in the fleet as soon as
            its server answers. Letters, digits, dash and underscore only.
          </p>
          {known.filter((entry) => !entry.alive).length ? (
            <div className="space-y-2">
              <h3 className="text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">Not running</h3>
              {known
                .filter((entry) => !entry.alive)
                .map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    disabled={creating}
                    onClick={() => void startSession(entry.id)}
                    className="tap w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-left text-sm disabled:opacity-40"
                  >
                    <div className="flex items-center gap-2">
                      <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-blocked)]" />
                      <span className="min-w-0 flex-1 truncate text-white">{entry.label}</span>
                      <span className="text-[0.65rem] text-[var(--color-accent)]">start</span>
                    </div>
                    <div className="mt-0.5 truncate text-[0.65rem] text-ink-400">{entry.socket}</div>
                  </button>
                ))}
            </div>
          ) : null}
          {known.filter((entry) => entry.alive).length ? (
            <div className="space-y-1">
              <h3 className="text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">Running</h3>
              {known
                .filter((entry) => entry.alive)
                .map((entry) => (
                  <div key={entry.id} className="flex items-center gap-2 rounded-xl border border-ink-800 px-3 py-2 text-sm">
                    <span className="inline-block h-2 w-2 rounded-full bg-[var(--color-done)]" />
                    <span className="min-w-0 flex-1 truncate text-ink-200">{entry.label}</span>
                  </div>
                ))}
            </div>
          ) : null}
          {sessionError ? <p className="text-[0.75rem] text-[var(--color-blocked)]">{sessionError}</p> : null}
        </div>
      </Sheet>

      <Sheet open={notifyOpen} onClose={() => setNotifyOpen(false)} title="Notifications">
        <div className="space-y-3">
          <Row label="permission" value={permission} />
          <Row label="sound alerts" value={muted ? "muted" : "on"} />
          <p className="text-[0.75rem] text-ink-400">{notificationHint(permission)}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => void askPermission()} disabled={permission === "granted" || permission === "unsupported"}>
              {permission === "default" ? "Allow notifications" : "Permission granted"}
            </Button>
            <Button onClick={testNotification} disabled={permission !== "granted"}>
              Send test notification
            </Button>
            <Button onClick={toggle} full>
              {muted ? "Unmute sound + alerts" : "Mute sound + alerts"}
            </Button>
          </div>
          {testSent ? <p className="text-[0.75rem] text-ink-200">{testSent}</p> : null}
          <p className="text-[0.7rem] text-ink-400">
            Blocked and finished agents notify once each, with a two-tone chime. Keep the tab open: a backgrounded
            tab still delivers notifications while the browser is running.
          </p>
        </div>
      </Sheet>

      <ConfirmSheet
        open={asked !== null}
        title={asked?.title ?? ""}
        body={asked?.body ?? ""}
        confirmLabel={asked?.label}
        busy={asking}
        onConfirm={() => void submit()}
        onClose={() => setAsked(null)}
      />

      <PromptSheet
        open={rename !== null}
        title={`Rename ${rename?.pane.display_agent ?? rename?.pane.agent ?? "agent"}`}
        field="Agent name"
        value={rename?.value ?? ""}
        placeholder={rename?.pane.agent ?? "agent"}
        hint="Letters, digits, dash and underscore. herdr keeps agent names unique per session."
        submitLabel="Rename"
        busy={renaming}
        onChange={(value) => setRename((current) => (current ? { ...current, value } : current))}
        onSubmit={() => void submitRename()}
        onClose={() => setRename(null)}
      />
    </Screen>
  );
}
