import { AnalysisWorkerPool } from "./worker-pool.js";
import { loopShapes, type LoopShape } from "./query-in-loop.js";

/** One file's loops, asked of a pool worker (`analyze-worker.ts`). */
export interface LoopShapeTask {
  file: { relativePath: string };
  loopShapes: { projectRoot: string };
}

interface LoopShapeResult {
  shapes: LoopShape[] | null;
}

/** Below this many files a pool's start-up costs more than building their graphs in-process. */
const POOL_FROM = 200;
/** In-process, a few files are read at a time: the graphs are CPU-bound, only the reads overlap. */
const IN_PROCESS_CONCURRENCY = 8;

/**
 * The loops of each of `files`, in their order: null where the language has no control-flow graph,
 * undefined where the worker building one died (the file is then not judged, and nothing should be
 * remembered for it). A graph is a pure function of the file's text and each takes a parse, so from
 * {@link POOL_FROM} files on they are built on worker threads — on a first run this was the longest
 * single step after reading the files.
 */
export async function loopShapesOfFiles(projectRoot: string, files: readonly string[]): Promise<Array<LoopShape[] | null | undefined>> {
  const inProcess = (task: LoopShapeTask): Promise<LoopShapeResult> =>
    loopShapes(task.loopShapes.projectRoot, task.file.relativePath).then((shapes) => ({ shapes }));
  const size = files.length >= POOL_FROM ? AnalysisWorkerPool.defaultSize(files.length) : 0;
  const pool = size > 0 ? AnalysisWorkerPool.create<LoopShapeTask, LoopShapeResult>(size, inProcess) : null;
  const out: Array<LoopShape[] | null | undefined> = new Array(files.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < files.length) {
      const i = next++;
      const task: LoopShapeTask = { file: { relativePath: files[i]! }, loopShapes: { projectRoot } };
      const done = await (pool ? pool.run(task) : inProcess(task));
      out[i] = done && "shapes" in done ? done.shapes : undefined;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(files.length, pool ? size + 2 : IN_PROCESS_CONCURRENCY) }, lane));
  } finally {
    await pool?.destroy();
  }
  return out;
}
