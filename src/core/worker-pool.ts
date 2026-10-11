/**
 * Minimal worker pool for per-file analysis. Each worker handles one task at
 * a time (the work is CPU-bound). If a worker dies mid-task, its task is
 * re-run in-process via the supplied fallback so a crash degrades to slower
 * analysis instead of lost files.
 */
import { Worker } from "worker_threads";
import os from "os";
import type { FileTask, FileResult } from "./file-analyzer.js";

interface Pending {
  task: FileTask;
  resolve: (r: FileResult | null) => void;
}

/**
 * A fixed set of worker threads that run `analyzeFile` off the main thread.
 *
 * Create one with `AnalysisWorkerPool.create`; `run` hands a task to the next
 * idle worker and resolves with its result, and `destroy` terminates the
 * threads. See the module comment for the crash-fallback behaviour.
 */
export class AnalysisWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  // Index-pointer queue per repo convention (no Array.shift()).
  private queue: Pending[] = [];
  private queueHead = 0;
  private pending = new Map<Worker, Pending>();
  private nextId = 0;
  private fallback: (task: FileTask) => Promise<FileResult | null>;

  private constructor(fallback: (task: FileTask) => Promise<FileResult | null>) {
    this.fallback = fallback;
  }

  /**
   * Try to create a pool. Returns null when workers can't be used (e.g.
   * running from source where dist/analyze-worker.js doesn't exist) — the
   * caller then analyzes in-process as before.
   */
  static create(
    size: number,
    fallback: (task: FileTask) => Promise<FileResult | null>,
  ): AnalysisWorkerPool | null {
    const workerUrl = new URL("./analyze-worker.js", import.meta.url);
    const pool = new AnalysisWorkerPool(fallback);
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

  run(task: FileTask): Promise<FileResult | null> {
    // All workers gone (crashed): analyze in-process instead of queueing forever.
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
    const workers = this.workers;
    this.workers = [];
    this.idle = [];
    await Promise.allSettled(workers.map((w) => w.terminate()));
  }

  private attach(worker: Worker): void {
    this.workers.push(worker);
    this.idle.push(worker);
    worker.on("message", (msg: { id: number; result: FileResult | null }) => {
      const item = this.pending.get(worker);
      this.pending.delete(worker);
      item?.resolve(msg.result);
      this.takeNext(worker);
    });
    worker.on("error", (err: Error) => {
      // Worker died: re-run its in-flight task in-process, drop the worker.
      const item = this.pending.get(worker);
      this.pending.delete(worker);
      this.workers = this.workers.filter((w) => w !== worker);
      this.idle = this.idle.filter((w) => w !== worker);
      if (item) {
        console.error(`  Analysis worker failed (${err.message}); retrying ${item.task.file.relativePath} in-process`);
        void this.fallback(item.task).then(item.resolve);
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
    });
  }

  private dispatch(worker: Worker, item: Pending): void {
    this.pending.set(worker, item);
    worker.postMessage({ id: this.nextId++, task: item.task });
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
