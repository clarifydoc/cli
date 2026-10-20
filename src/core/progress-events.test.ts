import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze, type AnalyzeProgressEvent } from "./analyzer.js";

describe("analyze --progress json", () => {
  it("reports each stage once, in order, the file count, and the end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-progress-"));
    try {
      await mkdir(join(dir, "app", "src"), { recursive: true });
      await writeFile(join(dir, "app", "package.json"), JSON.stringify({ name: "app" }));
      await writeFile(join(dir, "app", "src", "a.ts"), "export const a = () => 1;\n");
      await writeFile(join(dir, "app", "src", "b.ts"), 'import { a } from "./a";\nexport const b = () => a();\n');
      const events: AnalyzeProgressEvent[] = [];
      await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, incremental: true, onProgress: (e) => events.push(e) });
      const stages = events.filter((e) => e.event === "stage").map((e) => (e as { stage: string }).stage);
      expect(stages).toEqual(["discover", "detect", "analyze", "link", "advanced", "write"]);
      expect(events.find((e) => e.event === "stage" && e.stage === "analyze")).toMatchObject({ filesTotal: 3 });
      const files = events.filter((e) => e.event === "files");
      expect(files.at(-1)).toEqual({ event: "files", done: 3, total: 3 });
      expect(events.at(-1)).toMatchObject({ event: "done", files: expect.any(Number) });
      expect(events).toContainEqual({ event: "step", stage: "advanced", label: "Finding unreachable code" });

    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops at the next step when its signal aborts, writing no summary and releasing the lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clarifydoc-abort-"));
    try {
      await mkdir(join(dir, "app", "src"), { recursive: true });
      await writeFile(join(dir, "app", "package.json"), JSON.stringify({ name: "app" }));
      await writeFile(join(dir, "app", "src", "a.ts"), "export const a = () => 1;\n");
      const opts = { projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false, incremental: true };
      const abort = new AbortController();
      const stages: string[] = [];
      const run = analyze({
        ...opts,
        signal: abort.signal,
        onProgress: (e) => {
          if (e.event !== "stage") return;
          stages.push(e.stage);
          if (e.stage === "analyze") abort.abort(new Error("stop"));
        },
      });
      await expect(run).rejects.toThrow("stop");
      expect(stages).toEqual(["discover", "detect", "analyze"]);
      await expect(stat(join(dir, "out", "project-summary.json"))).rejects.toThrow();
      // The lock went with it: the next run goes through.
      await expect(analyze(opts)).resolves.toMatchObject({ fileCount: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
