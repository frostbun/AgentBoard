import fs from "node:fs";

type WatchEntry = {
  listeners: Set<() => void>;
  watcher: fs.FSWatcher | null;
  poll: NodeJS.Timeout | null;
  timer: NodeJS.Timeout | null;
  signature: string;
};

const entries = new Map<string, WatchEntry>();

function signatureOf(file: string): string {
  try {
    const stat = fs.statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

function fire(entry: WatchEntry, file: string): void {
  const signature = signatureOf(file);
  if (signature === entry.signature) return;
  entry.signature = signature;
  clearTimeout(entry.timer ?? undefined);
  entry.timer = setTimeout(() => {
    for (const listener of entry.listeners) listener();
  }, 40);
  entry.timer.unref?.();
}

/**
 * Calls `listener` when `file` changes.
 *
 * `fs.watch` gives near-instant delivery on the append-only session files, and a slow
 * stat poll covers the cases it misses (sqlite WAL writes, network filesystems,
 * editors that replace files). Entries are reference counted per path, so several
 * browsers on the same pane share one watcher.
 */
export function watchFile(file: string, listener: () => void): () => void {
  let entry = entries.get(file);
  if (!entry) {
    const created: WatchEntry = {
      listeners: new Set(),
      watcher: null,
      poll: null,
      timer: null,
      signature: signatureOf(file),
    };
    try {
      created.watcher = fs.watch(file, { persistent: false }, () => fire(created, file));
      created.watcher.on("error", () => {
        created.watcher?.close();
        created.watcher = null;
      });
    } catch {
      /* missing file: the poll below picks it up once it exists */
    }
    created.poll = setInterval(() => fire(created, file), 1500);
    created.poll.unref?.();
    entries.set(file, created);
    entry = created;
  }
  entry.listeners.add(listener);
  return () => {
    const current = entries.get(file);
    if (!current) return;
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      current.watcher?.close();
      clearInterval(current.poll ?? undefined);
      clearTimeout(current.timer ?? undefined);
      entries.delete(file);
    }
  };
}
