"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button, Screen, TopBar } from "@/components/bits";
import { SessionChip } from "@/components/session-chip";
import { activeSession, callAction, shortCwd, useBoard } from "@/components/use-board";
import { asRecord, asString } from "@/lib/json";
import { agentName, freeAgentName, modelArgs } from "@/lib/herdr/names";

type KindInfo = { kind: string; binary: string; path: string | null; installed: boolean };

/** herdr returns the created pane under `pane`, `root_pane`, or a bare `pane_id`. */
function pickPaneId(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) return null;
  for (const key of ["pane", "root_pane", "focused_pane"]) {
    const nested = asRecord(record[key]);
    const id = nested ? asString(nested.pane_id) : null;
    if (id) return id;
  }
  return asString(record.pane_id);
}

/** herdr reports `launch_pending` for a while; typing into a pane before its agent owns
 *  the terminal lands in the shell instead. */
async function waitForAgent(paneId: string, session: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let present = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`/api/state?session=${encodeURIComponent(session)}`, { cache: "no-store" });
      const state = (await response.json()) as { panes?: Array<{ pane_id: string; agent?: string | null; agent_status: string }> };
      const pane = state.panes?.find((candidate) => candidate.pane_id === paneId);
      if (pane?.agent) {
        present = true;
        if (pane.agent_status === "idle" || pane.agent_status === "done") return;
      }
    } catch {
      /* transient while the board reconnects */
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!present) throw new Error(`agent did not appear in ${paneId} within ${Math.round(timeoutMs / 1000)}s`);
}

/** Split wide panes to the right and tall ones down, keeping both halves usable. */
async function chooseSplitDirection(anchorPaneId: string | null): Promise<"right" | "down"> {
  if (!anchorPaneId) return "right";
  try {
    const layout = await callAction<{ layout?: { area?: { width?: number; height?: number } } }>("pane.layout", {
      pane_id: anchorPaneId,
    });
    const area = layout.layout?.area;
    const width = area?.width ?? 0;
    const height = area?.height ?? 0;
    if (width >= 120) return "right";
    if (height >= 30) return "down";
    return width >= height ? "right" : "down";
  } catch {
    return "right";
  }
}

/**
 * Starts one agent in one workspace. Which session and workspace is decided by the caller —
 * the fleet's workspace `+` link — so there is no "where" chooser here.
 */
export default function NewAgentPage() {
  const router = useRouter();
  const [spawnSession, setSpawnSession] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [kind, setKind] = useState("omp");
  const [kinds, setKinds] = useState<KindInfo[]>([]);
  const [name, setName] = useState("");
  /** Until the field is touched by hand it follows the kind and the names already in use. */
  const [nameEdited, setNameEdited] = useState(false);
  const [cwd, setCwd] = useState("");
  const [home, setHome] = useState("");
  const [args, setArgs] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const state = useBoard(spawnSession || undefined);

  // The link carries both values; the session picker can still change them afterwards.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlSession = params.get("session");
    const urlWorkspace = params.get("workspace");
    setSpawnSession(urlSession ?? activeSession() ?? "");
    if (urlWorkspace) setWorkspaceId(urlWorkspace);
  }, []);

  useEffect(() => {
    fetch("/api/agents", { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { agents: KindInfo[]; home?: string }) => {
        setKinds(payload.agents);
        setHome(payload.home ?? "");
      })
      .catch(() => setKinds([]));
  }, []);

  // Models come from whatever this machine already has configured for that agent.
  useEffect(() => {
    if (!kind) return;
    setModel("");
    fetch(`/api/models?kind=${encodeURIComponent(kind)}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((payload: { supported?: boolean; models?: string[]; note?: string }) => {
        setModels(payload.models ?? []);
        setModelNote(payload.supported ? payload.note ?? null : "this agent picks its model in its own UI");
      })
      .catch(() => setModels([]));
  }, [kind]);

  // A session with no workspaces has nothing to start an agent in.
  useEffect(() => {
    if (!spawnSession && state?.session) setSpawnSession(state.session);
  }, [spawnSession, state?.session]);

  const workspaces = state?.workspaces ?? [];
  useEffect(() => {
    if (workspaceId && workspaces.some((workspace) => workspace.workspace_id === workspaceId)) return;
    const preferred =
      workspaces.find((workspace) => workspace.workspace_id === state?.focused.workspace_id) ?? workspaces[0];
    setWorkspaceId(preferred?.workspace_id ?? "");
  }, [workspaces, workspaceId, state?.focused.workspace_id]);

  const workspace = workspaces.find((entry) => entry.workspace_id === workspaceId) ?? null;
  const askedName = useMemo(() => freeAgentName(kind, (state?.agents ?? []).map((agent) => agent.name)), [kind, state?.agents]);
  useEffect(() => {
    if (!nameEdited) setName(askedName);
  }, [askedName, nameEdited]);
  const knownCwds = useMemo(() => {
    const set = new Set<string>();
    for (const pane of state?.panes ?? []) {
      if (pane.workspace_id !== workspaceId) continue;
      const dir = pane.foreground_cwd ?? pane.cwd;
      if (dir) set.add(dir);
    }
    return [...set];
  }, [state?.panes, workspaceId]);

  useEffect(() => {
    if (cwd || !workspaceId) return;
    const first = knownCwds[0];
    if (first) setCwd(first);
  }, [cwd, workspaceId, knownCwds]);

  const anchorPaneId = () => {
    const panes = (state?.panes ?? []).filter((pane) => pane.workspace_id === workspaceId);
    return (panes.find((pane) => pane.focused) ?? panes[0])?.pane_id ?? null;
  };

  /** Model flag first, then whatever else was typed. */
  const agentArgs = (): string[] => [
    ...modelArgs(kind, model),
    ...(args.trim() ? args.trim().split(/\s+/) : []),
  ];

  const absoluteCwd = () => {
    const value = cwd.trim();
    if (value === "~") return home || value;
    if (value.startsWith("~/")) return home ? `${home}/${value.slice(2)}` : value;
    return value;
  };

  const create = async () => {
    setError(null);
    try {
      if (!workspace) throw new Error("pick a workspace first — the fleet's workspace + button links here");
      const anchor = anchorPaneId();

      setBusy("splitting pane…");
      const paneId = pickPaneId(
        await callAction(
          "pane.split",
          {
            ...(anchor ? { target_pane_id: anchor } : { workspace_id: workspace.workspace_id }),
            direction: await chooseSplitDirection(anchor),
            ...(absoluteCwd() ? { cwd: absoluteCwd() } : {}),
            focus: false,
          },
          60_000,
          spawnSession || undefined,
        ),
      );
      if (!paneId) throw new Error("herdr did not return a pane id");

      setBusy(`starting ${kind}…`);
      await callAction(
        "agent.start",
        {
          name: agentName(name.trim(), kind),
          kind,
          pane_id: paneId,
          ...(agentArgs().length ? { args: agentArgs() } : {}),
          timeout_ms: 120_000,
        },
        180_000,
        spawnSession || undefined,
      );

      if (prompt.trim()) {
        setBusy(`waiting for ${kind} to boot…`);
        await waitForAgent(paneId, spawnSession || activeSession(), 30_000);
        setBusy("sending first prompt…");
        const response = await fetch("/api/prompt", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pane: paneId, text: prompt.trim(), session: spawnSession || activeSession() }),
        });
        const payload = (await response.json()) as { error?: string };
        if (!response.ok || payload.error) throw new Error(payload.error ?? `prompt failed (${response.status})`);
      }

      router.push(`/a/${encodeURIComponent(paneId)}?session=${encodeURIComponent(spawnSession)}`);
    } catch (err) {
      const message = (err as Error).message;
      setError(
        /agent_name_taken/i.test(message)
          ? `the name “${agentName(name.trim(), kind)}” is already used in ${spawnSession || "this session"} — edit the name and start again`
          : message,
      );
    } finally {
      setBusy(null);
    }
  };

  const selected = kinds.find((entry) => entry.kind === kind);

  return (
    <Screen>
      <TopBar
        title="New agent"
        subtitle={workspace ? `${spawnSession} · ${workspace.label}` : spawnSession || "…"}
        badge={<SessionChip value={spawnSession || state?.session || ""} onChange={setSpawnSession} />}
      />

      <main className="scroll-y min-h-0 flex-1 space-y-4 px-3 pt-3 pb-4">
        <Link href="/" className="tap inline-flex items-center gap-1 text-sm text-ink-400">
          ← back to the board
        </Link>

        {workspaces.length === 0 ? (
          <div className="card px-3 py-4 text-sm text-ink-200">
            This session has no workspaces yet. Create one from the fleet — the <b>+</b> next to the session name
            takes a name and a directory.
          </div>
        ) : null}

        <section>
          <h2 className="mb-2 text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">Agent</h2>
          <div className="flex flex-wrap gap-2">
            {(kinds.length ? kinds : [{ kind: "omp", binary: "omp", path: null, installed: true }]).map((entry) => (
              <Button
                key={entry.kind}
                size="sm"
                tone={entry.kind === kind ? "accent" : "default"}
                disabled={!entry.installed}
                title={entry.installed ? entry.path ?? entry.kind : `${entry.binary} not on PATH here`}
                onClick={() => entry.installed && setKind(entry.kind)}
              >
                {entry.kind}
              </Button>
            ))}
          </div>
          {selected && !selected.installed ? (
            <p className="mt-2 text-[0.7rem] text-ink-400">
              {selected.binary} is not on PATH for the board — in Docker that check is skipped with
              AGENTBOARD_AGENT_CHECK=off, because herdr starts the agent on the host.
            </p>
          ) : null}
        </section>

        <section className="space-y-2">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">Workspace</h2>
          <select
            value={workspaceId}
            onChange={(event) => {
              setWorkspaceId(event.target.value);
              setCwd("");
            }}
            className="field"
          >
            {workspaces.map((entry) => (
              <option key={entry.workspace_id} value={entry.workspace_id}>
                {entry.number}. {entry.label}
              </option>
            ))}
          </select>
          <input
            list="known-cwds"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="working directory (defaults to the workspace's)"
            className="field"
          />
          <datalist id="known-cwds">
            {knownCwds.map((dir) => (
              <option key={dir} value={dir} />
            ))}
          </datalist>
          {knownCwds.length ? (
            <div className="flex flex-wrap gap-2">
              {knownCwds.slice(0, 4).map((dir) => (
                <Button key={dir} size="sm" onClick={() => setCwd(dir)}>
                  {shortCwd(dir)}
                </Button>
              ))}
            </div>
          ) : null}
        </section>

        <section className="space-y-2">
          <h2 className="text-[0.7rem] font-semibold uppercase tracking-wider text-ink-400">Details</h2>
          <input
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameEdited(true);
            }}
            placeholder="agent name, e.g. api-refactor"
            className="field"
          />
          <p className="text-[0.65rem] text-ink-400">
            herdr keeps agent names unique per session — the default follows the kind and adds <b>-2</b>, <b>-3</b>… when
            taken.
          </p>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            disabled={!models.length}
            className="field"
          >
            <option value="">model: agent default</option>
            {models.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
          {modelNote ? <p className="text-[0.65rem] text-ink-400">{modelNote}</p> : null}
          <input
            value={args}
            onChange={(event) => setArgs(event.target.value)}
            placeholder="extra args, e.g. --model opus"
            className="field"
          />
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="first prompt (optional)"
            className="field"
          />
        </section>

        {error ? <div className="rounded-lg border border-[var(--color-blocked)]/40 px-3 py-2 text-xs text-[var(--color-blocked)]">{error}</div> : null}

        <Button full tone="primary" disabled={Boolean(busy) || !kind || !workspace} onClick={() => void create()}>
          {busy ?? `Start ${kind} in ${workspace?.label ?? "…"}`}
        </Button>
      </main>
    </Screen>
  );
}
