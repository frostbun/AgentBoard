import { asArray, asRecord, asString, blockText, trimMessages } from "../json";
import { readJsonlTail } from "./jsonl";
import { modelLimits } from "./models";
import {
  QUESTION_TOOLS,
  emptySession,
  type ChatBlock,
  type ChatMsg,
  type ChatQuestion,
  type ChatSession,
  type ChatToolBlock,
  type ChatUsage,
  type NumericUsageField,
} from "./types";

type OmpQuestion = { id?: string; question?: string; options?: Array<{ label?: string; description?: string }>; multi?: boolean };

/** Questions arrive as `{questions:[…]}` (ask tool) or `{question, options}` in older builds. */
export function questionsFromToolArgs(args: unknown): ChatQuestion[] {
  const rec = asRecord(args);
  if (!rec) return [];
  const list = asArray(rec.questions);
  if (list.length) {
    return list
      .map((raw) => {
        const q = raw as OmpQuestion;
        const options = asArray(q.options).map((opt) => {
          const o = opt as { label?: string; description?: string };
          return { label: asString(o.label) ?? String(opt), description: asString(o.description) ?? undefined };
        });
        return { id: asString(q.id) ?? undefined, question: asString(q.question) ?? "", options, multi: Boolean(q.multi) };
      })
      .filter((q) => q.question.length > 0);
  }
  const single = asString(rec.question);
  if (single) {
    const options = asArray(rec.options).map((opt) => {
      const o = asRecord(opt);
      return { label: o ? asString(o.label) ?? "" : String(opt), description: o ? asString(o.description) ?? undefined : undefined };
    });
    return [{ question: single, options: options.filter((o) => o.label), multi: Boolean(rec.multi) }];
  }
  return [];
}

/**
 * omp session JSONL (`~/.omp/agent/sessions/<slug>/<ts>_<id>.jsonl`).
 * Records: session, title, model_change, message (user|assistant|toolResult), custom.
 */
export function readOmpSession(file: string, limit: number): ChatSession {
  const records = readJsonlTail(file);
  const session = emptySession("omp");
  session.source = "transcript";
  session.ref = file;

  const messages: ChatMsg[] = [];
  const tools = new Map<string, ChatToolBlock>();
  const usage: ChatUsage = {};
  let firstAt: number | null = null;
  let lastCompletedAt: number | null = null;
  const add = (field: NumericUsageField, value: number | undefined) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    usage[field] = (usage[field] ?? 0) + value;
  };

  for (const rec of records) {
    const type = asString(rec.type);
    if (type === "title") {
      session.title = asString(rec.title) ?? session.title;
      continue;
    }
    if (type === "session") {
      session.cwd = asString(rec.cwd);
      session.started_at = asString(rec.timestamp);
      continue;
    }
    if (type === "model_change") {
      session.model = asString(rec.model) ?? session.model;
      continue;
    }
    if (type === "custom") {
      if (asString(rec.customType) === "session_exit") {
        for (const block of tools.values()) if (block.state === "running") block.state = "ok";
      }
      continue;
    }
    if (type !== "message") continue;

    const message = asRecord(rec.message);
    if (!message) continue;
    const role = asString(message.role);

    // Assistant turns carry the provider's own accounting for that call.
    if (role === "assistant") {
      const turn = asRecord(message.usage);
      if (turn) {
        add("input_tokens", typeof turn.input === "number" ? turn.input : undefined);
        add("output_tokens", typeof turn.output === "number" ? turn.output : undefined);
        add("reasoning_tokens", typeof turn.reasoningTokens === "number" ? turn.reasoningTokens : undefined);
        add("cache_read_tokens", typeof turn.cacheRead === "number" ? turn.cacheRead : undefined);
        add("cache_write_tokens", typeof turn.cacheWrite === "number" ? turn.cacheWrite : undefined);
        const cost = asRecord(turn.cost);
        add("cost_usd", cost && typeof cost.total === "number" ? cost.total : undefined);
      }
      add("api_ms", typeof message.duration === "number" ? message.duration : undefined);
      add("ttft_ms", typeof message.ttft === "number" ? message.ttft : undefined);
      const snapshot = asRecord(message.contextSnapshot);
      if (snapshot && typeof snapshot.promptTokens === "number") usage.context_tokens = snapshot.promptTokens;
      if (typeof message.completedAt === "number") lastCompletedAt = message.completedAt as number;
      // A session started with `--model` never writes a model_change, so the first turn's
      // own model is the only place its model is named.
      if (session.model === null) session.model = asString(message.model) ?? null;
    }
    if (typeof message.timestamp === "number" && firstAt === null) firstAt = message.timestamp as number;
    if (typeof message.completedAt === "number") lastCompletedAt = message.completedAt as number;

    if (role === "toolResult") {
      const callId = asString(message.toolCallId);
      const block = callId ? tools.get(callId) : undefined;
      if (block) {
        block.result = blockText(message.content);
        block.state = message.isError === true ? "error" : "ok";
      }
      continue;
    }

    const blocks: ChatBlock[] = [];
    for (const raw of asArray(message.content)) {
      const block = asRecord(raw);
      const kind = block ? asString(block.type) : null;
      if (!block || !kind) continue;
      if (kind === "text") {
        const text = asString(block.text);
        if (text) blocks.push({ kind: "text", text });
      } else if (kind === "thinking") {
        const text = asString(block.thinking) ?? asString(block.text);
        if (text) blocks.push({ kind: "thinking", text });
      } else if (kind === "toolCall") {
        const id = asString(block.id) ?? `tool-${messages.length}-${blocks.length}`;
        const tool: ChatToolBlock = {
          kind: "tool",
          id,
          name: asString(block.name) ?? "tool",
          args: block.arguments ?? {},
          state: "running",
        };
        const questions = questionsFromToolArgs(block.arguments);
        if (questions.length) {
          tool.question = questions[0];
          tool.questionTotal = questions.length;
        }
        blocks.push(tool);
        tools.set(id, tool);
      }
    }
    if (!blocks.length) continue;
    messages.push({
      id: asString(rec.id) ?? `msg-${messages.length}`,
      role: role === "user" ? "user" : "assistant",
      at: asString(rec.timestamp) ?? undefined,
      blocks,
    });
  }

  const { messages: kept, truncated } = trimMessages(messages, limit);
  session.messages = kept;
  session.truncated = truncated;
  session.pending = pendingFromBlocks(kept);

  if (firstAt !== null && lastCompletedAt !== null) usage.wall_ms = Math.max(0, lastCompletedAt - firstAt);
  const cacheRead = usage.cache_read_tokens ?? 0;
  const fresh = usage.input_tokens ?? 0;
  if (cacheRead + fresh > 0) usage.cache_hit = cacheRead / (cacheRead + fresh);
  const limits = modelLimits(session.model);
  if (limits) {
    usage.context_max = limits.context;
    usage.context_max_source = limits.source;
  }
  if (Object.keys(usage).length) session.usage = usage;
  return session;
}

/** First unanswered question-shaped tool call wins; the terminal shows questions in order. */
export function pendingFromBlocks(messages: ChatMsg[]): ChatSession["pending"] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const block of messages[i].blocks) {
      if (block.kind !== "tool") continue;
      if (block.state !== "running" || !QUESTION_TOOLS.has(block.name)) continue;
      const questions = questionsFromToolArgs(block.args);
      if (!questions.length) continue;
      return { tool_id: block.id, tool: block.name, questions, index: 0 };
    }
  }
  return null;
}
