import { asArray, asRecord, asString, blockText, trimMessages } from "../json";
import { readJsonlTail } from "./jsonl";
import { modelLimits } from "./models";
import { questionsFromToolArgs, pendingFromBlocks } from "./omp";
import {
  emptySession,
  type ChatBlock,
  type ChatMsg,
  type ChatSession,
  type ChatToolBlock,
  type ChatUsage,
  type NumericUsageField,
} from "./types";

const SYSTEM_TAG = /^<(command-message|command-name|task-notification|system-reminder|local-command-stdout|user-prompt-submit-hook)/;

/**
 * Claude Code session JSONL (`~/.claude/projects/<slug>/<uuid>.jsonl`).
 * Records: user, assistant, ai-title, cost-state, system, attachment, file-history-*, …
 */
export function readClaudeSession(file: string, limit: number): ChatSession {
  const records = readJsonlTail(file);
  const session = emptySession("claude");
  session.source = "transcript";
  session.ref = file;

  const messages: ChatMsg[] = [];
  const tools = new Map<string, ChatToolBlock>();
  const usage: ChatUsage = {};
  let firstAt: number | null = null;
  let lastAt: number | null = null;
  const add = (field: NumericUsageField, value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    usage[field] = (usage[field] ?? 0) + value;
  };

  for (const rec of records) {
    const type = asString(rec.type);

    if (type === "ai-title") {
      session.title = asString(rec.aiTitle) ?? session.title;
      continue;
    }
    if (type === "cost-state") {
      // Authoritative session totals, retries and all.
      const perModel = asRecord(rec.modelUsage);
      const totals = perModel ? asRecord(Object.values(perModel)[0]) : null;
      usage.cost_usd = numberOr(rec.totalCostUSD) ?? usage.cost_usd;
      usage.api_ms = numberOr(rec.totalAPIDuration) ?? usage.api_ms;
      usage.tool_ms = numberOr(rec.totalToolDuration) ?? usage.tool_ms;
      usage.wall_ms = numberOr(rec.totalDuration) ?? usage.wall_ms;
      usage.input_tokens = numberOr(totals?.inputTokens) ?? usage.input_tokens;
      usage.output_tokens = numberOr(totals?.outputTokens) ?? usage.output_tokens;
      usage.reasoning_tokens = numberOr(totals?.thinkingTokens) ?? usage.reasoning_tokens;
      usage.cache_read_tokens = numberOr(totals?.cacheReadInputTokens) ?? usage.cache_read_tokens;
      usage.cache_write_tokens = numberOr(totals?.cacheCreationInputTokens) ?? usage.cache_write_tokens;
      continue;
    }
    if (type === "pr-link") {
      const url = asString(rec.prUrl);
      if (url) {
        messages.push({
          id: `pr-${messages.length}`,
          role: "note",
          at: asString(rec.timestamp) ?? undefined,
          blocks: [{ kind: "text", text: `PR #${rec.prNumber ?? "?"} — ${url}` }],
        });
      }
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;
    if (rec.isSidechain === true) continue;

    const message = asRecord(rec.message);
    if (!message) continue;
    const content = message.content;
    if (type === "assistant") {
      const turn = asRecord(message.usage);
      if (turn) {
        add("input_tokens", turn.input_tokens);
        add("output_tokens", turn.output_tokens);
        const details = asRecord(turn.output_tokens_details);
        add("reasoning_tokens", details?.thinking_tokens);
        add("cache_read_tokens", turn.cache_read_input_tokens);
        add("cache_write_tokens", turn.cache_creation_input_tokens);
        // Live context: what the last prompt actually consisted of.
        const used =
          (numberOr(turn.input_tokens) ?? 0) +
          (numberOr(turn.cache_read_input_tokens) ?? 0) +
          (numberOr(turn.cache_creation_input_tokens) ?? 0);
        if (used > 0) usage.context_tokens = used;
      }
      if (session.model === null) session.model = asString(message.model);
    }
    const at = asString(rec.timestamp);
    if (at) {
      const ms = Date.parse(at);
      if (Number.isFinite(ms)) {
        if (firstAt === null) firstAt = ms;
        lastAt = ms;
      }
    }
    const blocks: ChatBlock[] = [];
    let sawToolResult = false;

    if (typeof content === "string") {
      if (content.trim()) blocks.push({ kind: "text", text: content });
    } else {
      for (const raw of asArray(content)) {
        const block = asRecord(raw);
        const kind = block ? asString(block.type) : null;
        if (!block || !kind) continue;

        if (kind === "text") {
          const text = asString(block.text);
          if (text) blocks.push({ kind: "text", text });
        } else if (kind === "thinking") {
          const text = asString(block.thinking) ?? asString(block.text);
          if (text) blocks.push({ kind: "thinking", text });
        } else if (kind === "tool_use") {
          const id = asString(block.id) ?? `tool-${messages.length}-${blocks.length}`;
          const tool: ChatToolBlock = {
            kind: "tool",
            id,
            name: asString(block.name) ?? "tool",
            args: block.input ?? {},
            state: "running",
          };
          const questions = questionsFromToolArgs(block.input);
          if (questions.length) {
            tool.question = questions[0];
            tool.questionTotal = questions.length;
          }
          blocks.push(tool);
          tools.set(id, tool);
        } else if (kind === "tool_result") {
          sawToolResult = true;
          const target = asString(block.tool_use_id);
          const tool = target ? tools.get(target) : undefined;
          if (!tool) continue;
          tool.result = blockText(block.content);
          tool.state = block.is_error === true ? "error" : "ok";
        }
      }
    }

    if (sawToolResult && !blocks.length) continue;
    if (!blocks.length) continue;

    const first = blocks[0];
    const isMetaPrompt = first.kind === "text" && SYSTEM_TAG.test(first.text);
    messages.push({
      id: asString(rec.uuid) ?? `msg-${messages.length}`,
      role: type === "user" ? (isMetaPrompt ? "note" : "user") : "assistant",
      at: asString(rec.timestamp) ?? undefined,
      blocks,
    });
  }

  const { messages: kept, truncated } = trimMessages(messages, limit);
  session.messages = kept;
  session.truncated = truncated;
  session.pending = pendingFromBlocks(kept);

  if (usage.wall_ms === undefined && firstAt !== null && lastAt !== null) usage.wall_ms = Math.max(0, lastAt - firstAt);
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

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/** Claude stores a session in a directory derived from its cwd. */
export function claudeSessionPath(homeDir: string, cwd: string, id: string): string {
  const slug = cwd.replace(/[/\\]/g, "-");
  return `${homeDir}/.claude/projects/${slug}/${id}.jsonl`;
}
