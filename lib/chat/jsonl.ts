import fs from "node:fs";

/** Parsed records of one JSONL slice; a torn line from a mid-append read is dropped. */
export function parseJsonl(text: string, dropTornFirst: boolean): Record<string, unknown>[] {
  const lines = text.split("\n");
  if (dropTornFirst) lines.shift();
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object") records.push(parsed as Record<string, unknown>);
    } catch {
      /* torn write mid-append: skip */
    }
  }
  return records;
}

/** Last `maxBytes` of a JSONL file, parsed. */
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
  return parseJsonl(buf.toString("utf8"), start > 0);
}

/** First `maxBytes` of a JSONL file, parsed — where the agents write a session's title. */
export function readJsonlHead(file: string, maxBytes: number): Record<string, unknown>[] {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, 0);
    return parseJsonl(buf.subarray(0, read).toString("utf8"), false);
  } finally {
    fs.closeSync(fd);
  }
}
