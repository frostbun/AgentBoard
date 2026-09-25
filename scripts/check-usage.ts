import { readClaudeSession } from "../lib/chat/claude";
import { modelLimits } from "../lib/chat/models";
import { readOmpSession } from "../lib/chat/omp";
import { readOpencodeSession } from "../lib/chat/opencode";

const show = (label: string, session: { model: string | null; usage?: Record<string, unknown>; messages: unknown[] }) => {
  const usage = session.usage ?? {};
  const fmt = (value: unknown) =>
    typeof value === "number" ? (value > 10_000 ? `${Math.round(value / 1000)}k` : Math.round(value * 100) / 100) : String(value);
  console.log(`${label}: model=${session.model} messages=${session.messages.length}`);
  for (const [key, value] of Object.entries(usage)) console.log(`   ${key}: ${fmt(value)}`);
};

const [claudeFile, ompFile, sessionId] = process.argv.slice(2);
if (claudeFile) show("claude", readClaudeSession(claudeFile, 5));
if (ompFile) show("omp", readOmpSession(ompFile, 5));
if (sessionId) show("opencode", readOpencodeSession(sessionId, 5));
console.log("limits(deepseek-v4.1-flash):", modelLimits("deepseek/deepseek-v4.1-flash"));
console.log("limits(deepseek-v4-flash):", modelLimits("deepseek-v4-flash"));
