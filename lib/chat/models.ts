import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ModelLimits = {
  context: number;
  output?: number;
  /** `exact` matched the id; `family` dropped a version tag to find the closest sibling. */
  source: "exact" | "family";
  matched: string;
};

const REGISTRY_PATHS = [
  path.join(os.homedir(), ".cache", "opencode", "models.json"),
  path.join(os.homedir(), ".config", "opencode", "models.json"),
];

const CACHE_KEY = "__agentboard_model_limits__";
type LimitStore = typeof globalThis & { [CACHE_KEY]?: Map<string, ModelLimits> | null };

/**
 * Context windows per model id.
 *
 * opencode ships the models.dev registry (213 providers, ~4.4 MB) and keeps it on disk, so
 * the board reuses it instead of guessing: the same id appears under several gateways with
 * nearly identical limits, and the largest is taken as the model's capability. Unknown
 * models simply report no ceiling.
 */
function registry(): Map<string, ModelLimits> | null {
  const store = globalThis as LimitStore;
  if (store[CACHE_KEY] !== undefined) return store[CACHE_KEY];

  let limits: Map<string, ModelLimits> | null = null;
  for (const file of REGISTRY_PATHS) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
        string,
        { models?: Record<string, { limit?: { context?: number; output?: number } }> }
      >;
      limits = new Map();
      for (const provider of Object.values(parsed)) {
        for (const [id, model] of Object.entries(provider?.models ?? {})) {
          const context = model?.limit?.context;
          if (typeof context !== "number" || context <= 0) continue;
          const existing = limits.get(id);
          const output = model?.limit?.output;
          limits.set(id, {
            context: existing ? Math.max(existing.context, context) : context,
            output: existing?.output ?? (typeof output === "number" ? output : undefined),
            source: "exact",
            matched: id,
          });
        }
      }
      if (limits.size) break;
      limits = null;
    } catch {
      limits = null;
    }
  }
  store[CACHE_KEY] = limits;
  return limits;
}

/** Gateway naming adds version tags the registry does not know: v4.1 vs v4, date suffixes. */
function familyOf(id: string): string {
  return id.replace(/\.\d+/g, "").replace(/-\d{4}(-\d{2})?$/, "");
}

/** Tolerates provider-prefixed ids (`provider/model`), variants (`model[1m]`), and siblings. */
export function modelLimits(model: string | null | undefined): ModelLimits | null {
  if (!model) return null;
  const table = registry();
  if (!table) return null;

  const bare = model.split("/").pop() ?? model;
  const stripped = bare.replace(/\[[^\]]*\]$/, "");
  for (const candidate of [model, bare, stripped]) {
    const hit = table.get(candidate);
    if (hit) return hit;
  }
  const sibling = table.get(familyOf(stripped)) ?? table.get(familyOf(stripped).replace(/-flash$/, ""));
  return sibling ? { ...sibling, source: "family" } : null;
}
