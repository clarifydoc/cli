/**
 * Minimal worker pool for per-file analysis. Each worker handles one task at
 * a time (the work is CPU-bound). An ordinary error in a file is caught inside
 * the worker (`analyzeFileOutcome` settles with null). A worker that DIES on a
 * file — out of memory, killed past the per-file deadline, exited — settles
 * that file as failed (`FailedFile`) and is replaced: the file is never re-run
 * in-process, where the same file would take the whole run down with it, and
 * one pathological file cannot hang a run. The deadline runs from the moment
 * a worker takes the file up (its `begin` message), so a fresh worker's
 * start-up is not the file's time. Only when workers cannot run at all (the
 * first ones die before taking up any file, or none can be started again) do
 * tasks go through the in-process fallback.
 */
import { Worker } from "worker_threads";
import os from "os";
import type { FileTask, FileResult, SkippedFile } from "./file-analyzer.js";

/** A file its worker died on, and why: the run goes on without it. */
export interface FailedFile {
  failed: string;
}

/** What one task settles with: an analysis, a file its plugin refused (when the task asks), a file that killed its worker, or nothing. */
type Outcome = FileResult | SkippedFile | FailedFile | null;

interface Pending {
  task: FileTask;
  resolve: (r: Outcome) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** How long one file may take in a worker before it is killed and reported failed. */
const DEFAULT_DEADLINE_MS = 180_000;

/** `CLARIFYDOC_FILE_DEADLINE_MS` (0 = none), else the default. */
function deadlineFromEnv(): number {
  const raw = process.env.CLARIFYDOC_FILE_DEADLINE_MS;
  const n = raw === undefined || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEADLINE_MS;
}

export interface PoolOptions {
  /** Per-file deadline in milliseconds; 0 turns it off. Default: `CLARIFYDOC_FILE_DEADLINE_MS`, else 180 s. */
  deadlineMs?: number;
  /** The worker script (tests); default `./analyze-worker.js` beside this module. */
  workerUrl?: URL;
}

/**
 * A fixed set of worker threads that run `analyzeFile` off the main thread.
 *
 * Create one with `AnalysisWorkerPool.create`; `run` hands a task to the next
 * idle worker and resolves with its result, and `destroy` terminates the
 * threads. See the module comment for what a dying worker does.
 */
export class AnalysisWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  // Index-pointer queue per repo convention (no Array.shift()).
  private queue: Pending[] = [];
  private queueHead = 0;
  private pending = new Map<Worker, Pending>();
  private nextId = 0;
  /** Set once any worker has taken up a file: from then on a dead worker is its file's doing, not the pool's. */
  private started = false;
  private destroyed = false;
  private readonly fallback: (task: FileTask) => Promise<Outcome>;
  private readonly workerUrl: URL;
  private readonly deadlineMs: number;

  private constructor(fallback: (task: FileTask) => Promise<Outcome>, workerUrl: URL, deadlineMs: number) {
    this.fallback = fallback;
    this.workerUrl = workerUrl;
    this.deadlineMs = deadlineMs;
  }

  /**
   * Try to create a pool. Returns null when workers can't be used (e.g.
   * running from source where dist/analyze-worker.js doesn't exist) — the
   * caller then analyzes in-process as before.
   */
  static create(
    size: number,
    fallback: (task: FileTask) => Promise<Outcome>,
    options: PoolOptions = {},
  ): AnalysisWorkerPool | null {
    const workerUrl = options.workerUrl ?? new URL("./analyze-worker.js", import.meta.url);
    const pool = new AnalysisWorkerPool(fallback, workerUrl, options.deadlineMs ?? deadlineFromEnv());
    try {
      for (let i = 0; i < size; i++) {
        const worker = new Worker(workerUrl);
        pool.attach(worker);
      }
    } catch {
      void pool.destroy();
      return null;
    }
    return pool;
  }

  /** A sensible pool size: leave a core for the main thread, cap the total. */
  static defaultSize(fileCount: number): number {
    const envOverride = Number(process.env.CLARIFYDOC_WORKERS);
    if (Number.isInteger(envOverride) && envOverride >= 0) return envOverride;
    // Workers only pay off once there are enough files to amortize pool
    // startup (~0.5-1s for module + WASM grammar init across the pool).
    if (fileCount < 200) return 0;
    const cores = typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
    return Math.min(8, Math.max(1, cores - 1));
  }

  run(task: FileTask): Promise<Outcome> {
    // No worker left (none could be started): analyze in-process instead of queueing forever.
    if (this.workers.length === 0) return this.fallback(task);
    return new Promise((resolve) => {
      const item: Pending = { task, resolve };
      const worker = this.idle.pop();
      if (worker) {
        this.dispatch(worker, item);
      } else {
        this.queue.push(item);
      }
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    for (const item of this.pending.values()) clearTimeout(item.timer);
    await Promise.allSettled(workers.map((w) => w.terminate()));
  }

  private attach(worker: Worker): void {
    this.workers.push(worker);
    this.idle.push(worker);
    worker.on("message", (msg: { id: number; result?: Outcome; begin?: true }) => {
      this.started = true;
      if (msg.begin) {
        const item = this.pending.get(worker);
        if (item) this.startDeadline(worker, item);
        return;
      }
      const item = this.pending.get(worker);
      this.pending.delete(worker);
      if (item) {
        clearTimeout(item.timer);
        item.resolve(msg.result ?? null);
      }
      this.takeNext(worker);
    });
    worker.on("error", (err: Error & { code?: string }) => {
      const oom = err.code === "ERR_WORKER_OUT_OF_MEMORY";
      this.retire(worker, oom ? "out of memory" : `worker error: ${err.message}`, oom);
    });
    // A worker that ends without an error event (`process.exit`): `retire`
    // ignores one already retired, and every one `destroy` stops.
    worker.on("exit", (code: number) => this.retire(worker, `worker exited with code ${code}`, false));
  }

  /**
   * Take a dead (or killed) worker out of the pool. Its in-flight file settles
   * as failed and a fresh worker takes its place. Before any worker has
   * taken up a file, a death that is not the file's own (`fatal`: out of
   * memory, past the deadline) says workers cannot run here: the file goes to
   * the in-process fallback and nothing is respawned.
   */
  private retire(worker: Worker, reason: string, fatal: boolean): void {
    if (this.destroyed || !this.workers.includes(worker)) return;
    this.workers = this.workers.filter((w) => w !== worker);
    this.idle = this.idle.filter((w) => w !== worker);
    const item = this.pending.get(worker);
    this.pending.delete(worker);
    if (item) {
      clearTimeout(item.timer);
      if (this.started || fatal) {
        console.error(`  Analysis worker died on ${item.task.file.relativePath} (${reason}); file skipped`);
        item.resolve({ failed: reason });
        this.respawn();
      } else {
        console.error(`  Analysis worker failed (${reason}); analyzing ${item.task.file.relativePath} in-process`);
        void this.fallback(item.task).then(item.resolve);
      }
    }
    // Last worker gone: drain anything still queued through the fallback.
    if (this.workers.length === 0) {
      const remaining = this.queue.slice(this.queueHead);
      this.queue = [];
      this.queueHead = 0;
      for (const queued of remaining) {
        void this.fallback(queued.task).then(queued.resolve);
      }
    }
  }

  /** A fresh worker in a dead one's place, straight onto the queue. */
  private respawn(): void {
    let worker: Worker;
    try {
      worker = new Worker(this.workerUrl);
    } catch {
      return;
    }
    this.attach(worker);
    this.idle.pop();
    this.takeNext(worker);
  }

  private dispatch(worker: Worker, item: Pending): void {
    this.pending.set(worker, item);
    worker.postMessage({ id: this.nextId++, task: item.task });
  }

  /** From the moment the worker takes the file up (its `begin` message), not from dispatch. */
  private startDeadline(worker: Worker, item: Pending): void {
    if (this.deadlineMs <= 0) return;
    item.timer = setTimeout(() => {
      this.retire(worker, `no result within ${this.deadlineMs / 1000} s`, true);
      void worker.terminate();
    }, this.deadlineMs);
    item.timer.unref?.();
  }

  private takeNext(worker: Worker): void {
    if (!this.workers.includes(worker)) return;
    if (this.queueHead < this.queue.length) {
      const item = this.queue[this.queueHead++]!;
      if (this.queueHead === this.queue.length) {
        this.queue = [];
        this.queueHead = 0;
      }
      this.dispatch(worker, item);
    } else {
      this.idle.push(worker);
    }
  }
}
