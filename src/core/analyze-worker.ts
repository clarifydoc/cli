/**
 * Worker-thread entry for per-file analysis. The main thread (analyzer.ts)
 * spawns a small pool of these and dispatches one FileTask at a time to each.
 * Tree-sitter WASM + extractors are CPU-bound, so this is what lets analysis
 * use more than one core. Structured clone carries the task (including the
 * tsconfigAliases Map) and the FileResult back without manual serialization.
 */
import { parentPort } from "worker_threads";
import { analyzeFileOutcome, type FileTask } from "./file-analyzer.js";
import { loopShapes } from "./query-in-loop.js";
import type { LoopShapeTask } from "./loop-shape-batch.js";

interface WorkerRequest {
  id: number;
  task: FileTask | LoopShapeTask;
}

if (!parentPort) {
  throw new Error("analyze-worker must be run as a worker thread");
}

parentPort.on("message", (msg: WorkerRequest) => {
  // The file's deadline runs from here: module and grammar start-up of a
  // fresh worker are not the file's time.
  parentPort!.postMessage({ id: msg.id, begin: true });
  void (async () => {
    // analyzeFileOutcome catches per-file errors internally (returns null); this
    // outer catch only guards infrastructure failures so the pool's pending
    // promise always settles.
    let result: unknown = null;
    try {
      // The other work a pool hands out: one file's loops, for the query-in-loop pass.
      result = "loopShapes" in msg.task
        ? { shapes: await loopShapes(msg.task.loopShapes.projectRoot, msg.task.file.relativePath) }
        : await analyzeFileOutcome(msg.task);
    } catch (err) {
      console.error(`  Worker error analyzing ${msg.task.file.relativePath}: ${(err as Error).message}`);
    }
    parentPort!.postMessage({ id: msg.id, result });
  })();
});
