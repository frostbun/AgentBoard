import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { asRecord, asString, trimMessages } from "../json";
import { modelLimits } from "./models";
import {
  emptySession,
  type ChatBlock,
  type ChatMsg,
  type ChatSession,
  type ChatToolBlock,
  type ChatUsage,
  type NumericUsageField,
} from "./types";

const DEFAULT_DB = `${os.homedir()}/.local/share/opencode/opencode.db`;

/** node:sqlite hands back TEXT columns verbatim, so JSON blobs arrive as strings. */
function jsonColumn(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
const DB_CACHE_KEY = "__agentboard_opencode_db__";

function openDatabase(): DatabaseSync {
  const store = globalThis as typeof globalThis & { [DB_CACHE_KEY]?: DatabaseSync };
  if (!store[DB_CACHE_KEY]) {
    store[DB_CACHE_KEY] = new DatabaseSync(process.env.OPENCODE_DB ?? DEFAULT_DB, { readOnly: true });
  }
  return store[DB_CACHE_KEY];
}

const TOOL_STATE: Record<string, ChatToolBlock["state"]> = {
  completed: "ok",
  error: "error",
  pending: "running",
  running: "running",
};

/** opencode keeps transcripts in SQLite: session / message / part rows with JSON payloads. */
export function readOpencodeSession(sessionId: string, limit: number): ChatSession {
  const session = emptySession("opencode");
  session.ref = sessionId;
  let db: DatabaseSync;
  try {
    db = openDatabase();
  } catch (err) {
    session.error = `opencode db unavailable: ${(err as Error).message}`;
    return session;
  }

  try {
    const meta = asRecord(
      db.prepare("select title, directory, agent, cost, tokens_input, tokens_output, model from session where id = ?").get(sessionId),
    );
    if (!meta) {
      session.error = "session not found in opencode.db";
      return session;
    }
    session.source = "transcript";
    session.title = asString(meta.title);
    session.cwd = asString(meta.directory);
    // `model` is a JSON blob: {"id":"deepseek-v4-flash","providerID":"opencode-go"}
    const modelMeta = jsonColumn(meta.model);
    session.model = (modelMeta ? asString(modelMeta.id) : null) ?? asString(meta.model);
    // The session row carries this run's totals when opencode has written them; otherwise
    // they are summed from the messages below.
    const usage: ChatUsage = {};
    const set = (field: NumericUsageField, value: unknown) => {
      if (typeof value === "number" && Number.isFinite(value)) usage[field] = value;
    };
    // Per-field: opencode leaves the session aggregates null until compaction, so any
    // missing column falls back to the sum of this session's messages.
    const sums = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const created = typeof meta.time_created === "number" ? meta.time_created : undefined;
    const updated = typeof meta.time_updated === "number" ? meta.time_updated : undefined;
    if (created !== undefined && updated !== undefined) usage.wall_ms = Math.max(0, updated - created);

    const partsByMessage = new Map<string, Record<string, unknown>[]>();
    for (const row of db
      .prepare("select message_id, data from part where session_id = ? order by time_created, id")
      .all(sessionId)) {
      const rec = asRecord(row);
      const messageId = rec ? asString(rec.message_id) : null;
      const data = rec ? jsonColumn(rec.data) : null;
      if (!messageId || !data) continue;
      const list = partsByMessage.get(messageId) ?? [];
      list.push(data);
      partsByMessage.set(messageId, list);
    }

    const messages: ChatMsg[] = [];
    for (const row of db
      .prepare("select id, data, time_created from message where session_id = ? order by time_created, id")
      .all(sessionId)) {
      const rec = asRecord(row);
      const data = rec ? jsonColumn(rec.data) : null;
      const messageId = rec ? asString(rec.id) : null;
      if (!data || !messageId) continue;
      const blocks: ChatBlock[] = [];

      for (const part of partsByMessage.get(messageId) ?? []) {
        const kind = asString(part.type);
        if (kind === "text" || kind === "reasoning") {
          const text = asString(part.text);
          if (!text) continue;
          blocks.push(kind === "text" ? { kind: "text", text } : { kind: "thinking", text });
        } else if (kind === "tool") {
          const state = asRecord(part.state);
          const status = state ? asString(state.status) : null;
          blocks.push({
            kind: "tool",
            id: asString(part.callID) ?? `tool-${messageId}-${blocks.length}`,
            name: asString(part.tool) ?? "tool",
            args: state?.input ?? {},
            state: status ? (TOOL_STATE[status] ?? "running") : "running",
            result: state ? (asString(state.output) ?? undefined) : undefined,
          });
        }
      }

      const error = asRecord(data.error);
      if (error) blocks.push({ kind: "error", text: asString(error.message) ?? "agent error" });
      if (!blocks.length) continue;

      // Per-turn accounting, and the live context from the newest turn.
      const tokens = asRecord(data.tokens);
      if (tokens) {
        set("context_tokens", tokens.total);
        sums.input += typeof tokens.input === "number" ? tokens.input : 0;
        sums.output += typeof tokens.output === "number" ? tokens.output : 0;
        sums.reasoning += typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
        const cache = asRecord(tokens.cache);
        if (cache) {
          sums.cacheRead += typeof cache.read === "number" ? cache.read : 0;
          sums.cacheWrite += typeof cache.write === "number" ? cache.write : 0;
        }
      }
      if (typeof data.cost === "number") sums.cost += data.cost;
      const time = asRecord(data.time);
      if (time && typeof time.created === "number" && typeof time.completed === "number") {
        usage.api_ms = (usage.api_ms ?? 0) + Math.max(0, (time.completed as number) - (time.created as number));
      }

      messages.push({
        id: messageId,
        role: asString(data.role) === "user" ? "user" : "assistant",
        at:
          typeof rec?.time_created === "number"
            ? new Date(rec.time_created as number).toISOString()
            : undefined,
        blocks,
      });
    }

    const pick = (fromRow: unknown, summed: number): number | undefined =>
      typeof fromRow === "number" && fromRow > 0 ? fromRow : summed > 0 ? summed : undefined;
    set("input_tokens", pick(meta.tokens_input, sums.input));
    set("output_tokens", pick(meta.tokens_output, sums.output));
    set("reasoning_tokens", pick(meta.tokens_reasoning, sums.reasoning));
    set("cache_read_tokens", pick(meta.tokens_cache_read, sums.cacheRead));
    set("cache_write_tokens", pick(meta.tokens_cache_write, sums.cacheWrite));
    set("cost_usd", pick(meta.cost, sums.cost));

    const { messages: kept, truncated } = trimMessages(messages, limit);
    session.messages = kept;
    session.truncated = truncated;

    const cacheRead = usage.cache_read_tokens ?? 0;
    const fresh = usage.input_tokens ?? 0;
    if (cacheRead + fresh > 0) usage.cache_hit = cacheRead / (cacheRead + fresh);
    const limits = modelLimits(session.model);
    if (limits) usage.context_max = limits.context;
    if (Object.keys(usage).length) session.usage = usage;
    return session;
  } catch (err) {
    session.error = `opencode read failed: ${(err as Error).message}`;
    return session;
  }
}
