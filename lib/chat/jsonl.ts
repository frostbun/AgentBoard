import fs from "node:fs";

/** Last `maxBytes` of a JSONL file, parsed. A torn first line from a mid-append read is dropped. */
export function readJsonlTail(file: string, maxBytes = 12_000_000): Record<string, unknown>[] {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const length = stat.size - start;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (start > 0) lines.shift();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object") records.push(parsed as Record<string, unknown>);
    } catch {
      /* torn write mid-append: skip */
    }
  }
  return records;
}
