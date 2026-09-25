export type ChatRole = "user" | "assistant" | "note";

export type QuestionOption = { label: string; description?: string };

export type ChatQuestion = {
  id?: string;
  question: string;
  options: QuestionOption[];
  multi?: boolean;
};

export type ChatToolBlock = {
  kind: "tool";
  id: string;
  name: string;
  args: unknown;
  state: "running" | "ok" | "error";
  result?: string;
  question?: ChatQuestion;
  /** Number of questions in this call; option keys advance one prompt at a time. */
  questionTotal?: number;
};

export type ChatBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | ChatToolBlock
  | { kind: "error"; text: string };

export type ChatMsg = {
  id: string;
  role: ChatRole;
  at?: string;
  blocks: ChatBlock[];
};

export type PendingQuestion = {
  tool_id: string;
  tool: string;
  questions: ChatQuestion[];
  /** Index of the question the terminal is showing now (unanswerable ones are skipped). */
  index: number;
};

/** Every usage field except the non-numeric annotations. */
export type NumericUsageField = Exclude<keyof ChatUsage, "context_max_source">;

export type ChatUsage = {
  /** Summed over the session's turns. */
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost_usd?: number;
  /** Provider time, summed over turns. */
  api_ms?: number;
  /** Time to first token, summed over turns. */
  ttft_ms?: number;
  tool_ms?: number;
  /** Wall clock: first turn start to last turn completion. */
  wall_ms?: number;
  /** Size of the prompt on the most recent turn — the live context. */
  context_tokens?: number;
  /** Context window of the model, when the model registry knows it. */
  context_max?: number;
  /** `family` when the window came from a sibling model id rather than an exact match. */
  context_max_source?: "exact" | "family";
  /** cache_read / (cache_read + input), the share of the prompt served from cache. */
  cache_hit?: number;
};

export type ChatSession = {
  agent: string;
  source: "transcript" | "none";
  ref: string | null;
  /** Whether herdr named this session or the board inferred it from the pane's cwd. */
  refSource?: "herdr" | "discovered" | "none";
  /** herdr named a session file that the agent has not written yet. */
  awaitingFirstMessage?: boolean;
  title: string | null;
  cwd: string | null;
  model: string | null;
  started_at: string | null;
  messages: ChatMsg[];
  pending: PendingQuestion | null;
  usage?: ChatUsage;
  truncated?: boolean;
  error?: string;
};

export const QUESTION_TOOLS = new Set(["ask", "question", "AskUserQuestion", "ask_user"]);

export function emptySession(agent: string, error?: string): ChatSession {
  return {
    agent,
    source: "none",
    ref: null,
    title: null,
    cwd: null,
    model: null,
    started_at: null,
    messages: [],
    pending: null,
    error,
  };
}

