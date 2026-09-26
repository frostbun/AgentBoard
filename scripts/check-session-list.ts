/**
 * Runnable check for the session listing behind the resume sheet: `bun run check:session-list`.
 *
 * The outcome labels are the agents' own (omp's session list renders done/interrupted/aborted),
 * so they are asserted against the record shapes those agents actually write, and the omp
 * directory encoding is asserted against its rule (home-relative, `-` for every separator).
 * The end-to-end case builds a store in a temp dir: a listing that cannot find a session there
 * is exactly the bug the resume sheet had.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentSessions, ompOutcome, ompSessionDir, opencodeOutcome, claudeOutcome } from "../lib/chat/sessions";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const ompAssistant = (stopReason: string, toolCall = false) => ({
  type: "message",
  message: { role: "assistant", stopReason, content: toolCall ? [{ type: "toolCall", id: "c1" }] : [{ type: "text", text: "ok" }] },
});

check("omp: a finished turn is done", ompOutcome([{ type: "session" }, ompAssistant("stop")]) === "done");
check("omp: an aborted turn says so", ompOutcome([ompAssistant("aborted")]) === "aborted");
check("omp: a length stop is interrupted", ompOutcome([ompAssistant("length")]) === "interrupted");
check("omp: tool calls left open mean interrupted", ompOutcome([ompAssistant("toolUse", true)]) === "interrupted");
check("omp: a failed turn is an error", ompOutcome([ompAssistant("error")]) === "error");
check("omp: a trailing tool result is interrupted", ompOutcome([ompAssistant("stop"), { type: "message", message: { role: "toolResult" } }]) === "interrupted");
check("omp: an unanswered prompt is pending", ompOutcome([{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }]) === "pending");
check("omp: an empty session is unknown", ompOutcome([]) === "unknown");

const claudeAssistant = (stop: string | null) => ({ type: "assistant", message: { role: "assistant", stop_reason: stop, content: [] } });
const claudeUser = (content: unknown) => ({ type: "user", message: { role: "user", content } });

check("claude: end_turn is done", claudeOutcome([claudeAssistant("end_turn")]) === "done");
check("claude: max_tokens is interrupted", claudeOutcome([claudeAssistant("max_tokens")]) === "interrupted");
check("claude: a stop-less content record is skipped", claudeOutcome([claudeAssistant(null), claudeAssistant("end_turn")]) === "done");
check("claude: an interrupt marker is aborted", claudeOutcome([claudeUser("[Request interrupted by user]")]) === "aborted");
check(
  "claude: an interrupt marker inside blocks is aborted",
  claudeOutcome([claudeUser([{ type: "text", text: "[Request interrupted by user for tool use]" }])]) === "aborted",
);
check("claude: a trailing tool result is interrupted", claudeOutcome([claudeUser([{ type: "tool_result", content: "x" }])]) === "interrupted");
check("claude: an unanswered prompt is pending", claudeOutcome([claudeUser("do the thing")]) === "pending");
check("claude: hook output is not a prompt", claudeOutcome([claudeUser("<local-command-stdout>noise</local-command-stdout>")]) === "unknown");
check("claude: sidechains and meta records are skipped", claudeOutcome([{ ...claudeAssistant("end_turn"), isSidechain: true }, { ...claudeAssistant("end_turn"), isMeta: true }]) === "unknown");

check("opencode: a stopped turn is done", opencodeOutcome({ role: "assistant", finish: "stop" }) === "done");
check("opencode: a failed turn is an error", opencodeOutcome({ role: "assistant", error: { name: "x" } }) === "error");
check("opencode: a cut stream is interrupted", opencodeOutcome({ role: "assistant", time: { completed: 1 } }) === "interrupted");
check("opencode: open tool calls mean interrupted", opencodeOutcome({ role: "assistant", finish: "tool-calls" }) === "interrupted");
check("opencode: an unanswered prompt is pending", opencodeOutcome({ role: "user" }) === "pending");
check("opencode: no message is unknown", opencodeOutcome(null) === "unknown");

const HOME = "/home/dev";
check("omp dir: home-relative, separators flattened", ompSessionDir(`${HOME}/Projects/demo`, HOME) === "-Projects-demo");
check("omp dir: the home itself is a lone dash", ompSessionDir(HOME, HOME) === "-");
check("omp dir: outside the home keeps the full path", ompSessionDir("/srv/app", HOME) === "--srv-app--");
check("omp dir: dots survive", ompSessionDir(`${HOME}/Projects/a.b`, HOME) === "-Projects-a.b");

/* End to end against a store of the shape the agents write. */
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-sessions-"));
const cwd = path.join(root, "Projects", "demo");
const ompDir = path.join(root, ".omp", "agent", "sessions", "-Projects-demo");
const claudeDir = path.join(root, ".claude", "projects", cwd.replace(/[/\\]/g, "-").replace(/\./g, "-"));
fs.mkdirSync(ompDir, { recursive: true });
fs.mkdirSync(claudeDir, { recursive: true });

const ompId = "01a0dd24-76cf-73ac-8f11-f931255088a0";
fs.writeFileSync(
  path.join(ompDir, `2026-09-26T09-55-49-583Z_${ompId}.jsonl`),
  [
    JSON.stringify({ type: "title", title: "Fix resume listing" }),
    JSON.stringify({ type: "session", id: ompId, cwd }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }),
    JSON.stringify(ompAssistant("aborted")),
    JSON.stringify({ type: "session_exit", customType: "session_exit", data: { reason: "sighup", kind: "signal" } }),
    "",
  ].join("\n"),
);
const claudeId = "158352ce-9a5b-4d3b-9f2e-2f1c5b7a9d10";
fs.writeFileSync(
  path.join(claudeDir, `${claudeId}.jsonl`),
  [
    JSON.stringify({ type: "user", message: { role: "user", content: "is everything back to its state?" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [] } }),
    "",
  ].join("\n"),
);

const listed = listAgentSessions([cwd], { home: root });
check("listing finds the omp session", listed.some((entry) => entry.agent === "omp" && entry.id === ompId), listed);
check("listing finds the claude session", listed.some((entry) => entry.agent === "claude" && entry.id === claudeId), listed);
check("listing keeps the omp title", listed.find((entry) => entry.agent === "omp")?.title === "Fix resume listing");
check("listing reads the omp outcome", listed.find((entry) => entry.agent === "omp")?.outcome === "aborted");
check("listing falls back to the first prompt", listed.find((entry) => entry.agent === "claude")?.title === "is everything back to its state?");
check("listing keeps the cwd", listed.every((entry) => entry.cwd === cwd));
check("listing is newest first", listed.every((entry, index) => index === 0 || listed[index - 1].updated_at >= entry.updated_at));
check("an unrelated directory lists nothing", listAgentSessions([path.join(root, "elsewhere")], { home: root }).length === 0);

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
