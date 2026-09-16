/**
 * A cross-process advisory lock over one analysis directory.
 *
 * The analysis now lives in the project (`<root>/.clarifydoc/<name>`), so the
 * CLI, the VS Code extension and an MCP server's cold start all write the SAME
 * directory — and two concurrent runs would interleave per-file JSON and fight
 * over the incremental manifest. One exclusive file create (`O_EXCL`, atomic on
 * every platform we target) elects a single writer; everyone else is told who
 * holds it and can wait for the summary instead of scanning.
 *
 * The lock is advisory and self-healing. A crashed run leaves its file behind,
 * so a holder is stolen when its pid is gone (same host) or when its heartbeat
 * stopped more than STALE_MS ago — the heartbeat is what makes a legitimately
 * long analysis safe from being stolen out from under it.
 */

import { hostname } from "os";
import { open, readFile, stat, mkdir, unlink, utimes } from "fs/promises";
import { join } from "path";

const LOCK_FILE = ".analysis-lock.json";
/** How often the holder touches the lock to prove it is alive. */
const HEARTBEAT_MS = 30_000;
/** A lock whose heartbeat is older than this is assumed dead. 4× the beat. */
const STALE_MS = 120_000;

export interface LockOwner {
  pid: number;
  host: string;
  startedAt: string;
  /** What the holder is doing, for the message another process prints. */
  label?: string;
}

export interface AnalysisLock {
  path: string;
  owner: LockOwner;
  release(): Promise<void>;
}

/** Thrown when an analysis cannot start because another run owns the directory. */
export class AnalysisLockedError extends Error {
  constructor(
    readonly dir: string,
    readonly owner: LockOwner | null,
  ) {
    const who = owner
      ? `pid ${owner.pid}${owner.host === hostname() ? "" : ` on ${owner.host}`}, started ${owner.startedAt}`
      : "another process";
    super(
      `Another ClarifyDoc analysis is writing ${dir} (${who}). ` +
        `Wait for it to finish, or delete ${join(dir, LOCK_FILE)} if that run is gone.`,
    );
    this.name = "AnalysisLockedError";
  }
}

export function lockPath(dir: string): string {
  return join(dir, LOCK_FILE);
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch {
    return null;
  }
}

/** Whether a pid is still running on THIS host. EPERM means alive but foreign. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lock's contents, or null when absent/unreadable/corrupt. */
export async function readLockOwner(dir: string): Promise<LockOwner | null> {
  try {
    const raw = await readFile(lockPath(dir), "utf-8");
    const parsed = JSON.parse(raw) as LockOwner;
    return typeof parsed?.pid === "number" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The live holder of the lock, or null when the directory is free (no lock, or
 * one left behind by a run that died). Never steals — callers that only want to
 * know whether to wait use this.
 */
export async function currentLockHolder(dir: string): Promise<LockOwner | null> {
  const info = await statOrNull(lockPath(dir));
  if (!info) return null;
  const owner = await readLockOwner(dir);
  if (owner && owner.host === hostname() && !pidAlive(owner.pid)) return null;
  if (Date.now() - info.mtimeMs > STALE_MS) return null;
  return owner ?? { pid: -1, host: "unknown", startedAt: new Date(info.mtimeMs).toISOString() };
}

/**
 * Take the lock, or return null when a live run already holds it. A dead
 * holder's lock is removed and the acquire retried once.
 */
export async function acquireAnalysisLock(dir: string, label?: string): Promise<AnalysisLock | null> {
  await mkdir(dir, { recursive: true });
  const path = lockPath(dir);
  const owner: LockOwner = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    ...(label ? { label } : {}),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify(owner));
      await handle.close();

      // Keep mtime fresh so a long analysis is never mistaken for a dead one.
      const beat = setInterval(() => {
        const now = new Date();
        void utimes(path, now, now).catch(() => {});
      }, HEARTBEAT_MS);
      beat.unref?.();

      let released = false;
      return {
        path,
        owner,
        async release() {
          if (released) return;
          released = true;
          clearInterval(beat);
          await unlink(path).catch(() => {});
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (await currentLockHolder(dir)) return null;
      // Stale: the holder crashed or stopped beating. Clear it and retry once.
      await unlink(path).catch(() => {});
    }
  }
  return null;
}

/**
 * Wait until `predicate` holds (polling), for use while another process owns
 * the lock. Resolves false on timeout so the caller can report honestly rather
 * than hang.
 */
export async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  pollMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  }
}
