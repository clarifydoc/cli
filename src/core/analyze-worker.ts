/**
 * Worker-thread entry for per-file analysis. The main thread (analyzer.ts)
 * spawns a small pool of these and dispatches one FileTask at a time to each.
 * Tree-sitter WASM + extractors are CPU-bound, so this is what lets analysis
 * use more than one core. Structured clone carries the task (including the
 * tsconfigAliases Map) and the FileResult back without manual serialization.
 */
import { parentPort } from "worker_threads";
import { analyzeFileOutcome, type FileTask } from "./file-analyzer.js";

interface WorkerRequest {
  id: number;
  task: FileTask;
}

if (!parentPort) {
  throw new Error("analyze-worker must be run as a worker thread");
}

parentPort.on("message", (msg: WorkerRequest) => {
  void (async () => {
    // analyzeFileOutcome catches per-file errors internally (returns null); this
    // outer catch only guards infrastructure failures so the pool's pending
    // promise always settles.
    let result: unknown = null;
    try {
      result = await analyzeFileOutcome(msg.task);
    } catch (err) {
      console.error(`  Worker error analyzing ${msg.task.file.relativePath}: ${(err as Error).message}`);
    }
    parentPort!.postMessage({ id: msg.id, result });
  })();
});
