"use client";

import { useEffect, useState } from "react";
import { Button, IconButton, Sheet } from "./bits";
import { rememberSession } from "./use-board";

export type SessionInfo = { id: string; label: string; socket: string; alive: boolean; current: boolean };

function useSessions(): { sessions: SessionInfo[]; error: string | null } {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/sessions", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { sessions: SessionInfo[] }) => setSessions(payload.sessions))
      .catch(() => setError("could not list sessions"));
  }, []);
  return { sessions, error };
}

/**
 * herdr session picker for the spawn form. The fleet lists every session at once and the chat
 * names its session in the controls sheet, so both need no chip.
 */
export function SessionChip({
  value,
  onChange,
}: {
  value: string;
  onChange?: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { sessions, error } = useSessions();
  const label = sessions.find((entry) => entry.id === value)?.label ?? (value || "…");

  return (
    <>
      <IconButton label={`herdr session: ${label} — tap to choose`} onClick={() => setOpen(true)}>
        <span className="text-ink-400">⇄</span> <span className="max-w-32 truncate">{label}</span>
      </IconButton>

      <Sheet open={open} onClose={() => setOpen(false)} title="herdr session">
        <div className="space-y-2">
          {error ? <p className="text-[0.75rem] text-[var(--color-blocked)]">{error}</p> : null}
          {sessions.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => {
                rememberSession(entry.id);
                onChange?.(entry.id);
                setOpen(false);
              }}
              className={`tap w-full rounded-xl border px-3 py-2 text-left text-sm ${
                entry.id === value ? "border-[var(--color-accent)] bg-[var(--color-accent)]/15" : "border-ink-700 bg-ink-900"
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${entry.alive ? "bg-[var(--color-done)]" : "bg-[var(--color-blocked)]"}`} />
                <span className="min-w-0 flex-1 truncate text-white">{entry.label}</span>
                {entry.id === value ? <span className="text-[0.65rem] text-[var(--color-accent)]">selected</span> : null}
              </div>
              <div className="mt-0.5 truncate text-[0.65rem] text-ink-400">{entry.socket || "console default"}</div>
            </button>
          ))}
          {sessions.length === 0 && !error ? <p className="text-[0.75rem] text-ink-400">looking for sessions…</p> : null}
          <Button full onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Sheet>
    </>
  );
}
