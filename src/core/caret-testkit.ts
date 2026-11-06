import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { checkCaretAssertions, formatCaretFailures, type CaretFile, type CaretResult } from "./caret-assertions.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

/**
 * A vitest helper for caret assertions (`caret-assertions.ts`): writes a small
 * project to a temp directory, analyzes it, and judges the assertions written in
 * its files. Not imported by the product.
 *
 *     await expectCarets({ "repo.js": ["function listClubs() {}", "//        ^^^^^^^^^ def listClubs"].join("\n") });
 */
export interface CaretRun {
  analysis: ProjectAnalysis;
  files: Map<string, CaretFile>;
  results: CaretResult[];
}

/** Analyzes `sources` (project-relative path → text) and checks every caret assertion in them. */
export async function runCarets(sources: Record<string, string>): Promise<CaretRun> {
  const dir = await mkdtemp(join(tmpdir(), "clarifydoc-carets-"));
  try {
    const root = join(dir, "project");
    for (const [rel, text] of Object.entries(sources)) {
      await mkdir(dirname(join(root, rel)), { recursive: true });
      await writeFile(join(root, rel), text);
    }
    const out = join(dir, "out");
    await analyze({ projectRoot: root, outputDir: out, lsp: false, gitHistory: false, stableOutput: true });
    const analysis = await loadReportSummary(out);
    const files = new Map<string, CaretFile>();
    for (const path of analysis.files ?? []) {
      if (sources[path] === undefined) continue;
      try {
        files.set(path, { source: sources[path]!, analysis: JSON.parse(await readFile(join(out, `${path}.json`), "utf-8")) as FileAnalysis });
      } catch {
        // No per-file JSON: its assertions are not judged, which `expectCarets` reports below.
      }
    }
    return { analysis, files, results: checkCaretAssertions(analysis, files) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Throws, listing each assertion that did not pass (and what was found there instead), when any did not. Also fails when none were found. */
export async function expectCarets(sources: Record<string, string>): Promise<CaretRun> {
  const run = await runCarets(sources);
  if (run.results.length === 0) throw new Error("no caret assertions were found in the analyzed files");
  const bad = formatCaretFailures(run.results);
  if (bad.length > 0) throw new Error(`${bad.length} of ${run.results.length} caret assertion(s) did not pass:\n${bad.join("\n")}`);
  return run;
}
