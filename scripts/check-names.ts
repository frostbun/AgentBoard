/** Run: bun run check. Asserts the agent-name rules herdr enforces on `agent.start`. */
import { agentName, freeAgentName } from "../lib/herdr/names";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

check("slug keeps herdr's charset", agentName("API Refactor!") === "api-refactor", agentName("API Refactor!"));
check("slug never starts with a digit or dash", agentName("2 fast") === "fast", agentName("2 fast"));
check("empty input falls back", agentName("   ", "agent") === "agent");
check("a free name is kept", freeAgentName("omp", []) === "omp");
check("a taken name is suffixed", freeAgentName("omp", ["omp"]) === "omp-2", freeAgentName("omp", ["omp"]));
check("the first free counter wins", freeAgentName("omp", ["omp", "omp-2", "omp-3"]) === "omp-4");
check("suffixes respect the 32-character limit", freeAgentName("x".repeat(40), ["x".repeat(32)]).length === 32, freeAgentName("x".repeat(40), ["x".repeat(32)]));
check("unrelated names do not collide", freeAgentName("claude", ["omp", null, undefined]) === "claude");

console.log(`\n${failures === 0 ? "8/8 passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
