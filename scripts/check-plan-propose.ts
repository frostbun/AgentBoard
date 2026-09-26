/**
 * Runnable check for omp plan-mode proposals: `bun run check:plan-propose`.
 *
 * Plan mode submits a plan by writing `xd://propose`; omp answers that tool result by opening
 * its own "Plan mode - next step" select, and it writes `mode_change` when plan mode starts
 * (default plan file) and when it ends (any answer, including "Save and quit"). The board
 * mirrors the select only while the transcript's last word is the proposal, so these are the
 * record shapes to read: the tool call, the result's `xdev` details, and both mode changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readOmpSession } from "../lib/chat/omp";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.error(`FAIL ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentboard-plan-"));

/** One session file per case; the readers stat it, so it has to exist on disk. */
const session = (name: string, records: unknown[]): string => {
  const file = path.join(root, name);
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  return file;
};

/** The two records a plan-mode submit leaves: the write, then omp's own result payload. */
const propose = (id: string, content: string, details?: unknown) => [
  {
    type: "message",
    timestamp: "2026-09-23T06:47:21.673Z",
    message: { role: "assistant", content: [{ type: "toolCall", id, name: "write", arguments: { path: "xd://propose", content } }] },
  },
  {
    type: "message",
    timestamp: "2026-09-23T06:47:21.673Z",
    message: { role: "toolResult", toolCallId: id, toolName: "write", content: [{ type: "text", text: "Plan ready for review." }], details },
  },
];

const xdev = (file: string, title: string) => ({
  xdev: { tool: "propose", mode: "execute", args: { title }, inner: { planFilePath: file, title, planExists: true } },
});

const modeChange = (mode: string, planFilePath?: string) => ({
  type: "mode_change",
  timestamp: "2026-09-23T06:47:21.715Z",
  mode,
  data: planFilePath ? { planFilePath } : undefined,
});

const header = { type: "session", cwd: "/home/dev/Projects/demo" };
const proposed = "local://verdaccio-repo-deploy-plan.md";

/* A proposal is pending until the session records how it was answered. */
const pending = session("pending.jsonl", [
  header,
  modeChange("plan", "local://PLAN.md"),
  ...propose("call_1", "verdaccio-repo-deploy\n\nSplit the registries out…", xdev(proposed, "verdaccio-repo-deploy")),
  modeChange("plan", proposed),
]);
const plan = readOmpSession(pending, 250).plan;
check(
  "propose: omp's own title and plan file are the pending proposal",
  plan?.title === "verdaccio-repo-deploy" && plan?.file === proposed,
  plan,
);

const answered = session("answered.jsonl", [
  header,
  modeChange("plan", "local://PLAN.md"),
  ...propose("call_1", "verdaccio-repo-deploy\n\nSplit the registries out…", xdev(proposed, "verdaccio-repo-deploy")),
  modeChange("plan", proposed),
  modeChange("none"),
]);
check("propose: leaving plan mode clears it", readOmpSession(answered, 250).plan === null, readOmpSession(answered, 250).plan);

/* Approving in place writes `plan_paused` — omp resumes plan mode once the plan is done — so
 * the answer rule is "any mode that is not `plan`", not a list of terminal modes. */
const approved = session("approved.jsonl", [
  header,
  modeChange("plan", "local://PLAN.md"),
  ...propose("call_1", "verdaccio-repo-deploy\n\nSplit the registries out…", xdev(proposed, "verdaccio-repo-deploy")),
  modeChange("plan", proposed),
  modeChange("plan_paused"),
]);
check("propose: a paused plan mode clears it too", readOmpSession(approved, 250).plan === null);

/* Older results carry no `xdev` payload: the slug comes from the write, the file from omp's
 * follow-up record (the state still says `local://PLAN.md` when the write lands). */
const noDetails = session("no-details.jsonl", [
  header,
  modeChange("plan", "local://PLAN.md"),
  ...propose("call_2", "git-submodule-parallel\n\nAdd `git submodule-parallel`…"),
  modeChange("plan", "local://git-submodule-parallel-plan.md"),
]);
const fallback = readOmpSession(noDetails, 250).plan;
check(
  "propose: without details the slug is the first line and the file follows from plan mode",
  fallback?.title === "git-submodule-parallel" && fallback?.file === "local://git-submodule-parallel-plan.md",
  fallback,
);

/* Plan mode itself is not a proposal, and only a write to the device is one. */
const entryOnly = session("entry-only.jsonl", [header, modeChange("plan", "local://PLAN.md")]);
check("plan mode: entering it proposes nothing", readOmpSession(entryOnly, 250).plan === null);

const readDevice = session("read-device.jsonl", [
  header,
  modeChange("plan", "local://PLAN.md"),
  {
    type: "message",
    timestamp: "2026-09-23T06:47:21.673Z",
    message: { role: "assistant", content: [{ type: "toolCall", id: "call_3", name: "read", arguments: { path: "xd://propose" } }] },
  },
  {
    type: "message",
    timestamp: "2026-09-23T06:47:21.673Z",
    message: { role: "toolResult", toolCallId: "call_3", toolName: "read", content: [{ type: "text", text: "no" }] },
  },
]);
check("propose: a read of the device is not a proposal", readOmpSession(readDevice, 250).plan === null);

/* Refining keeps plan mode on and proposes again: the newest proposal is the pending one. */
const refined = session("refined.jsonl", [
  header,
  modeChange("plan", "local://x-plan.md"),
  ...propose("call_4", "x-plan\n\nfirst attempt", xdev("local://x-plan.md", "x-plan")),
  { type: "message", timestamp: "2026-09-23T06:48:00.000Z", message: { role: "user", content: [{ type: "text", text: "make step 2 cheaper" }] } },
  ...propose("call_5", "x-plan\n\nsecond attempt", xdev("local://x-plan.md", "x-plan")),
]);
check("propose: a re-proposal is the pending one", readOmpSession(refined, 250).plan?.title === "x-plan");

/* The question path rides the same reader and must not have been disturbed. */
const asked = session("asked.jsonl", [
  header,
  {
    type: "message",
    timestamp: "2026-09-23T06:40:00.000Z",
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_6",
          name: "ask",
          arguments: { questions: [{ id: "secrets", question: "How should secrets be handled?", options: [{ label: "Org secrets" }], multi: false }] },
        },
      ],
    },
  },
]);
check("questions: a running ask is still the pending question", readOmpSession(asked, 250).pending?.tool === "ask");

fs.rmSync(root, { recursive: true, force: true });

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
