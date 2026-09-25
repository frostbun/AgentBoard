/** Pure JSON/narrowing helpers shared by server readers and client views. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function blockText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        const record = asRecord(part);
        return record ? (asString(record.text) ?? "") : typeof part === "string" ? part : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  return record ? (asString(record.text) ?? "") : "";
}

export function trimMessages<T>(messages: T[], limit: number): { messages: T[]; truncated: boolean } {
  if (messages.length <= limit) return { messages, truncated: false };
  return { messages: messages.slice(-limit), truncated: true };
}

/** Slug agent CLIs use for per-project session directories. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\]/g, "-").replace(/^\./, "-");
}
