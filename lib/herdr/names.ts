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

/** Which agents accept a model flag when started, and how it is passed. */
export function supportsModel(kind: string): boolean {
  return ["omp", "pi", "claude"].includes(kind);
}

/** `` for agents whose TUI chooses its own model (opencode). */
export function modelArgs(kind: string, model: string | null | undefined): string[] {
  if (!model || !supportsModel(kind)) return [];
  return ["--model", model];
}

/** Verified CLI flags for reopening an agent's own session. */
export function resumeArgs(agent: string | null | undefined, ref: AgentSessionRef | undefined): string[] | null {
  if (!ref) return null;
  switch (agent) {
    case "omp":
    case "pi":
      return ["--resume", ref.value];
    case "claude":
      return ["--resume", ref.value];
    case "opencode":
      return ["--session", ref.value];
    case "codex":
      return ["resume", ref.value];
    default:
      return null;
  }
}
