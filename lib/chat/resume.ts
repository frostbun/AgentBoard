import type { AgentSessionRef } from "@/lib/herdr/types";

/** Verified CLI invocations for reopening an agent's own session. */
export function resumeCommand(agent: string | null | undefined, ref: AgentSessionRef | undefined): string | null {
  if (!ref) return null;
  const id = ref.value;
  switch (agent) {
    case "omp":
    case "pi":
      return `omp --resume ${id}`;
    case "claude":
      return `claude --resume ${id}`;
    case "opencode":
      return `opencode --session ${id}`;
    case "codex":
      return `codex resume ${id}`;
    default:
      return null;
  }
}
