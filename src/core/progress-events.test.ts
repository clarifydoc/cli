import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
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
});
