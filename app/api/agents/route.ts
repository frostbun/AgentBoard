import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

export const dynamic = "force-dynamic";

const run = promisify(execFile);

/** Kinds accepted by `herdr agent start`. */
const KINDS = [
  "omp",
  "claude",
  "opencode",
  "codex",
  "gemini",
  "cursor",
  "droid",
  "kimi",
  "qwen",
  "copilot",
  "amp",
  "grok",
  "kilo",
  "hermes",
  "letta",
  "devin",
  "mastracode",
] as const;

const BINARY: Record<string, string> = {
  omp: "omp",
  claude: "claude",
  opencode: "opencode",
  codex: "codex",
  gemini: "gemini",
  cursor: "cursor-agent",
  droid: "droid",
  kimi: "kimi",
  qwen: "qwen",
  copilot: "copilot",
  amp: "amp",
  grok: "grok",
  kilo: "kilo",
  hermes: "hermes",
  letta: "letta",
  devin: "devin",
  mastracode: "mastracode",
};

export async function GET(): Promise<Response> {
  // In a container the agents live on the host, so PATH here says nothing about them.
  if (process.env.AGENTBOARD_AGENT_CHECK === "off") {
    return Response.json(
      {
        agents: KINDS.map((kind) => ({ kind, binary: BINARY[kind] ?? kind, path: null, installed: true })),
        // Directories the user types are resolved by herdr on the host, so report its home.
        home: process.env.AGENTBOARD_HOST_HOME || os.homedir(),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const checks = await Promise.all(
    KINDS.map(async (kind) => {
      const binary = BINARY[kind] ?? kind;
      try {
        const { stdout } = await run("which", [binary], { timeout: 2000 });
        return { kind, binary, path: stdout.trim(), installed: stdout.trim().length > 0 };
      } catch {
        return { kind, binary, path: null, installed: false };
      }
    }),
  );
  return Response.json(
    { agents: checks, home: process.env.AGENTBOARD_HOST_HOME || os.homedir() },
    { headers: { "cache-control": "no-store" } },
  );
}
