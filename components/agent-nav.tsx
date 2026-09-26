"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton, StatusDot } from "./bits";
import { shortCwd, timeAgo, useAllSessions, type SessionSnapshot } from "./use-board";
import { STATUS_ORDER, type BoardPane } from "@/lib/herdr/types";

type NavAgent = { pane: BoardPane; session: SessionSnapshot };

/** Agents waiting on you: blocked before done (STATUS_ORDER), newest change first. */
function needsYou(sessions: SessionSnapshot[]): NavAgent[] {
  return sessions
    .flatMap((session) => session.state.panes.map((pane) => ({ pane, session })))
    .filter(({ pane }) => pane.agent && (pane.agent_status === "blocked" || pane.agent_status === "done"))
    .sort(
      (a, b) =>
        STATUS_ORDER[a.pane.agent_status] - STATUS_ORDER[b.pane.agent_status] ||
        (b.pane.last_change_at ?? 0) - (a.pane.last_change_at ?? 0),
    );
}

function NavRow({ agent, current, onNavigate }: { agent: NavAgent; current: boolean; onNavigate: () => void }) {
  const { pane, session } = agent;
  // Name precedence of the fleet's AgentRow: the renameable herdr name lives on the agent record.
  const label =
    pane.display_agent ??
    session.state.agents.find((entry) => entry.pane_id === pane.pane_id)?.name ??
    pane.agent ??
    pane.pane_id;
  return (
    <Link
      href={`/a/${encodeURIComponent(pane.pane_id)}?session=${encodeURIComponent(session.id)}`}
      onClick={onNavigate}
      className={`flex items-center gap-2 border-b border-ink-850 px-3 py-2 last:border-0 ${
        current ? "bg-[var(--color-accent)]/15" : "active:bg-ink-800"
      }`}
    >
      <StatusDot status={pane.agent_status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-white">{label}</span>
        <span className="block truncate text-[0.68rem] text-ink-400">
          {pane.workspace_label} · {shortCwd(pane.foreground_cwd ?? pane.cwd)}
        </span>
      </span>
      <span className="shrink-0 text-[0.65rem] text-ink-400">
        {current ? <span className="text-[var(--color-accent)]">here</span> : timeAgo(pane.last_change_at)}
      </span>
    </Link>
  );
}

export function AgentNav({ paneId }: { paneId: string }) {
  const [open, setOpen] = useState(false);
  const { sessions, ready } = useAllSessions();
  const waiting = needsYou(sessions);
  const agents = sessions.reduce((total, session) => total + session.state.panes.filter((pane) => pane.agent).length, 0);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Switching chats keeps this component mounted, so navigation closes the drawer.
  useEffect(() => close(), [paneId]);

  return (
    <>
      <IconButton
        label={waiting.length ? `Switch agent — ${waiting.length} need you` : "Switch agent"}
        onClick={() => setOpen(true)}
      >
        ☰
        {waiting.length ? (
          <span className="text-[0.65rem] font-semibold text-[var(--color-blocked)]">{waiting.length}</span>
        ) : null}
      </IconButton>
      {open
        ? createPortal(
            <div className="fixed inset-0 z-40 bg-black/60" onClick={close} role="presentation">
              <div
                role="dialog"
                aria-modal="true"
                aria-label="Agents"
                onClick={(event) => event.stopPropagation()}
                className="pad-top pad-bottom flex h-dvh w-[82%] max-w-80 flex-col border-r border-ink-800 bg-ink-900"
              >
                <div className="flex items-center justify-between gap-2 px-3 pb-2">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-400">
                    Agents{waiting.length ? ` · ${waiting.length} need you` : ""}
                  </h2>
                  <IconButton label="Close" onClick={close}>
                    Close
                  </IconButton>
                </div>

                <div className="scroll-y min-h-0 flex-1">
                  {waiting.length ? (
                    <>
                      <h3 className="px-3 pt-2 pb-1 text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">
                        Needs you
                      </h3>
                      <div className="card mx-3 mb-2 overflow-hidden">
                        {waiting.map((agent) => (
                          <NavRow
                            key={`waiting:${agent.session.id}:${agent.pane.pane_id}`}
                            agent={agent}
                            current={agent.pane.pane_id === paneId}
                            onNavigate={close}
                          />
                        ))}
                      </div>
                    </>
                  ) : null}

                  {sessions.map((session) => {
                    const groups = session.state.workspaces
                      .map((workspace) => ({
                        workspace,
                        panes: session.state.panes.filter(
                          (pane) => pane.workspace_id === workspace.workspace_id && Boolean(pane.agent),
                        ),
                      }))
                      .filter((group) => group.panes.length > 0);
                    if (!groups.length) return null;
                    return (
                      <div key={session.id}>
                        <h3 className="px-3 pt-3 pb-1 text-[0.75rem] font-semibold text-[var(--color-accent)]">
                          ⇄ {session.label}
                        </h3>
                        {groups.map(({ workspace, panes }) => (
                          <div key={`${session.id}:${workspace.workspace_id}`} className="mb-2">
                            <div className="px-3 pb-1 text-[0.68rem] text-ink-400">
                              {workspace.number}. {workspace.label}
                            </div>
                            <div className="card mx-3 overflow-hidden">
                              {panes.map((pane) => (
                                <NavRow
                                  key={pane.pane_id}
                                  agent={{ pane, session }}
                                  current={pane.pane_id === paneId}
                                  onNavigate={close}
                                />
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })}

                  {!ready ? (
                    <p className="px-3 py-4 text-center text-xs text-ink-400">connecting…</p>
                  ) : agents ? null : (
                    <p className="px-3 py-4 text-center text-xs text-ink-400">no agents yet</p>
                  )}
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
