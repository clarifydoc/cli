import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { AnalysisWorkerPool } from "./worker-pool.js";
import type { FileTask } from "./file-analyzer.js";

/**
 * A worker that dies on a file must cost that file, not the run: the file is
 * reported failed, never re-run on the main thread (where the same file would
 * end the process), and a fresh worker takes the rest of the queue. A file
 * that never finishes is killed at the deadline the same way.
 */
let dir: string;
let workerUrl: URL;
let brokenUrl: URL;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "clarifydoc-pool-"));
  const script = join(dir, "worker.mjs");
  // Behaves by file name: answers, exits, throws outside the task, or spins.
  writeFileSync(
    script,
    `import { parentPort } from "worker_threads";
parentPort.on("message", ({ id, task }) => {
  parentPort.postMessage({ id, begin: true });
  const name = task.file.relativePath;
  if (name.startsWith("exit")) process.exit(3);
  if (name.startsWith("throw")) setTimeout(() => { throw new Error("gearbox seized"); });
  else if (name.startsWith("spin")) for (;;) {}
  else parentPort.postMessage({ id, result: { analysis: { filePath: name } } });
});
`,
  );
  workerUrl = pathToFileURL(script);
  // A worker that cannot even start (its engine is missing).
  const broken = join(dir, "broken.mjs");
  writeFileSync(broken, `throw new Error("no engine");\n`);
  brokenUrl = pathToFileURL(broken);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const task = (name: string) => ({ file: { relativePath: name } }) as unknown as FileTask;

describe("AnalysisWorkerPool", () => {
  it("reports a file whose worker died as failed, respawns, and finishes the queue", async () => {
    const fallback = vi.fn(async () => null);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = AnalysisWorkerPool.create(1, fallback, { workerUrl, deadlineMs: 0 })!;
    try {
      expect(await pool.run(task("car.c"))).toEqual({ analysis: { filePath: "car.c" } });
      const results = await Promise.all(["exit-garage.c", "throw-garage.c", "bay.c", "lane.c"].map((n) => pool.run(task(n))));
      expect(results[0]).toEqual({ failed: "worker exited with code 3" });
      expect(results[1]).toEqual({ failed: "worker error: gearbox seized" });
      expect(results.slice(2)).toEqual([{ analysis: { filePath: "bay.c" } }, { analysis: { filePath: "lane.c" } }]);
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await pool.destroy();
    }
  });

  it("kills a file past the deadline and goes on", async () => {
    const fallback = vi.fn(async () => null);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = AnalysisWorkerPool.create(1, fallback, { workerUrl, deadlineMs: 1500 })!;
    try {
      const [spun, next] = await Promise.all([pool.run(task("spin-engine.c")), pool.run(task("wheel.c"))]);
      expect(spun).toEqual({ failed: "no result within 1.5 s" });
      expect(next).toEqual({ analysis: { filePath: "wheel.c" } });
      expect(fallback).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await pool.destroy();
    }
  });

  it("runs files in-process when no worker can start", async () => {
    const fallback = vi.fn(async (t: FileTask) => ({ analysis: { filePath: `main:${t.file.relativePath}` } }) as never);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const pool = AnalysisWorkerPool.create(1, fallback, { workerUrl: brokenUrl, deadlineMs: 0 })!;
    try {
      const results = await Promise.all([pool.run(task("car.c")), pool.run(task("tyre.c"))]);
      expect(results).toEqual([{ analysis: { filePath: "main:car.c" } }, { analysis: { filePath: "main:tyre.c" } }]);
    } finally {
      errors.mockRestore();
      await pool.destroy();
    }
  });
});
