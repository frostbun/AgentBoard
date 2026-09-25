import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonlTail } from "../chat/jsonl";
import { asString } from "../json";

/**
 * Model ids worth offering, taken from what is already installed on this machine: omp's
 * custom-provider list plus models its own sessions ran, and Claude Code's provider config.
 * Nothing invented — a model that is not listed can still be typed in.
 */
const CACHE_KEY = "__agentboard_models__";
const CACHE_TTL_MS = 60_000;
type ModelStore = typeof globalThis & { [CACHE_KEY]?: Map<string, { at: number; models: string[] }> };

function recentOmpModels(limit: number): string[] {
  const root = path.join(os.homedir(), ".omp", "agent", "sessions");
  const files: Array<{ file: string; mtime: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 2) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith(".jsonl")) {
        try {
          files.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, 0);
  const seen = new Set<string>();
  for (const { file } of files.sort((a, b) => b.mtime - a.mtime).slice(0, 8)) {
    for (const record of readJsonlTail(file, 400_000)) {
      if (record.type !== "model_change") continue;
      const model = asString(record.model);
      if (model) seen.add(model);
    }
  }
  return [...seen].slice(0, limit);
}

function ompConfigModels(): string[] {
  const file = path.join(os.homedir(), ".omp", "agent", "models.yml");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  // Tiny YAML subset: `provider:` blocks with `- id: model` entries.
  const models: string[] = [];
  let provider: string | null = null;
  for (const line of text.split("\n")) {
    const providerMatch = /^(\w[\w.-]*):\s*$/.exec(line);
    if (providerMatch) {
      provider = providerMatch[1];
      continue;
    }
    const idMatch = /^\s*-\s*id:\s*(\S+)\s*$/.exec(line);
    if (idMatch) {
      models.push(idMatch[1]);
      if (provider) models.push(`${provider}/${idMatch[1]}`);
    }
  }
  return provider === null ? [] : models;
}

function claudeConfigModels(): string[] {
  const file = path.join(os.homedir(), ".claude", "providers-config.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      providers?: Record<string, { enabled?: boolean; models?: unknown }>;
    };
    const models: string[] = [];
    for (const entry of Object.values(parsed.providers ?? {})) {
      if (entry?.enabled === false) continue;
      const list = entry?.models;
      if (Array.isArray(list)) {
        for (const model of list) {
          if (typeof model === "string") models.push(model);
          else if (model && typeof model === "object") {
            const id = asString((model as Record<string, unknown>).id);
            if (id) models.push(id);
          }
        }
      } else if (list && typeof list === "object") {
        // Keyed by id, like {"glm-5.2": {...}, "glm-5.1": {...}}
        models.push(...Object.keys(list));
      }
    }
    return models;
  } catch {
    return [];
  }
}

export function candidateModels(kind: string): string[] {
  const store = globalThis as ModelStore;
  if (!store[CACHE_KEY]) store[CACHE_KEY] = new Map();
  const cached = store[CACHE_KEY]!.get(kind);
  // Short TTL: configs and session files change while the board runs.
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.models;

  // Agents without a model flag have nothing to offer (opencode picks its model in-TUI).
  const models =
    kind === "omp" || kind === "pi"
      ? [...recentOmpModels(24), ...ompConfigModels()]
      : kind === "claude"
        ? claudeConfigModels()
        : [];

  const unique = [...new Set(models.filter((model) => model.length > 0 && model.length < 80))].slice(0, 60);
  store[CACHE_KEY]!.set(kind, { at: Date.now(), models: unique });
  return unique;
}
