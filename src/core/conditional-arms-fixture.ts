import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";

/** Test helper: analyze a small project written from `files` and read the call links of one source file back. */
export async function analyzeFiles(files: Record<string, string>): Promise<{ dir: string; linksOf: (file: string, fn: string, call: string) => Promise<string[]>; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-arms-"));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await analyze({ projectRoot: dir, outputDir: join(dir, ".clarifydoc"), lsp: false, gitHistory: false });
  const summary = await loadReportSummary(join(dir, ".clarifydoc"));
  return {
    dir,
    linksOf: async (file, fn, call) =>
      (summary.symbolLinks ?? [])
        .filter((l) => l.sourceFile === file && l.sourceSymbol === fn && l.callName === call && l.relation !== "reference")
        .map((l) => `${l.targetSymbol}:${l.confidence}`)
        .sort(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
