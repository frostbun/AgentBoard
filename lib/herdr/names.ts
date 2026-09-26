import type { AgentSessionRef } from "./types";

/** herdr agent names must match `[a-z][a-z0-9_-]{0,31}`. */
export function agentName(label: string, fallback = "agent"): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 32);
  return slug || fallback;
}

/**
 * A name herdr will accept: `agent.start` refuses a name another agent in the session already
 * holds (`agent_name_taken`), so a second `omp` becomes `omp-2`. Suffixes stay inside herdr's
 * 32-character limit by truncating the base rather than the counter.
 */
export function freeAgentName(desired: string, taken: Iterable<string | null | undefined>): string {
  const used = new Set([...taken].filter((name): name is string => Boolean(name)));
  const base = agentName(desired);
  if (!used.has(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const counter = `-${suffix}`;
    const candidate = `${base.slice(0, 32 - counter.length)}${counter}`;
    if (!used.has(candidate)) return candidate;
  }
  return base;
}

/** Which agents accept a model flag when started, and how it is passed. */
export function supportsModel(kind: string): boolean {
  return ["omp", "pi", "claude"].includes(kind);
}

/** `` for agents whose TUI chooses its own model (opencode). */
export function modelArgs(kind: string, model: string | null | undefined): string[] {
  if (!model || !supportsModel(kind)) return [];
  return ["--model", model];
}

/** The executable that carries the resume flag, when it is not the agent's own name. */
const RESUME_BINARY: Record<string, string> = { omp: "omp", pi: "omp", claude: "claude", opencode: "opencode", codex: "codex" };

/**
 * The session id as the agent's own CLI expects it. herdr usually reports the transcript
 * *path* (omp names files `<timestamp>_<id>.jsonl`), while every resume flag takes the id —
 * `claude --resume <path>` is not a session at all.
 */
export function sessionId(ref: AgentSessionRef): string {
  if (ref.kind !== "path") return ref.value;
  const name = (ref.value.split("/").pop() ?? ref.value).replace(/\.jsonl$/, "");
  const separator = name.lastIndexOf("_");
  return separator >= 0 ? name.slice(separator + 1) : name;
}

/** Verified CLI flags for reopening an agent's own session. */
export function resumeArgs(agent: string | null | undefined, ref: AgentSessionRef | undefined): string[] | null {
  if (!ref) return null;
  const id = sessionId(ref);
  switch (agent) {
    case "omp":
    case "pi":
      return ["--resume", id];
    case "claude":
      return ["--resume", id];
    case "opencode":
      return ["--session", id];
    case "codex":
      return ["resume", id];
    default:
      return null;
  }
}

/** The same invocation as a copy-pasteable line for the terminal on this machine. */
export function resumeCommand(agent: string | null | undefined, ref: AgentSessionRef | undefined): string | null {
  const args = resumeArgs(agent, ref);
  const binary = agent ? RESUME_BINARY[agent] : undefined;
  return args && binary ? [binary, ...args].join(" ") : null;
}

/** Agents that take a model argument; the same ones the board can switch at runtime. */
export function modelCommand(kind: string | null | undefined, model: string | null | undefined): string | null {
  if (!kind || !model || !supportsModel(kind)) return null;
  return `/model ${model}`;
}
