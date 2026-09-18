import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { analyze } from "./analyzer.js";

/**
 * Two runs over the same source must produce the same bytes.
 *
 * Nothing asserted this before, and the risk was not theoretical: ordering came
 * from `localeCompare` (locale-dependent) and the worker pool is never
 * exercised by the fixture suite, because every fixture is below the 200-file
 * threshold at which workers engage. This runs each project twice — once
 * in-process, once through the pool — and compares every artifact.
 */
const REPO_ROOT = resolve(__dirname, "..", "..");
const PROJECTS = ["sample-backend", "sample-pressure", "sample-python-api"];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function readTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, prefix: string) => {
    for (const entry of readdirSync(d).sort()) {
      const abs = join(d, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(abs).isDirectory()) walk(abs, rel);
      // report.html is not written by these runs; lsp artifacts need Docker.
      else if (entry.endsWith(".json") && !entry.startsWith("lsp-")) {
        out[rel] = readFileSync(abs, "utf-8");
      }
    }
  };
  walk(dir, "");
  return out;
}

async function run(project: string, workers: string): Promise<Record<string, string>> {
  const out = mkdtempSync(join(tmpdir(), "clarifydoc-determinism-"));
  dirs.push(out);
  const previous = process.env.CLARIFYDOC_WORKERS;
  process.env.CLARIFYDOC_WORKERS = workers;
  try {
    await analyze({
      projectRoot: resolve(REPO_ROOT, "test-fixtures", project),
      outputDir: out,
      pretty: true,
      lsp: false,
      gitHistory: false,
      stableOutput: true,
    });
  } finally {
    if (previous === undefined) delete process.env.CLARIFYDOC_WORKERS;
    else process.env.CLARIFYDOC_WORKERS = previous;
  }
  return readTree(out);
}

describe("analysis is deterministic", () => {
  for (const project of PROJECTS) {
    it(`${project}: two in-process runs agree byte for byte`, async () => {
      const [first, second] = [await run(project, "0"), await run(project, "0")];
      expect(Object.keys(second).sort()).toEqual(Object.keys(first).sort());
      for (const key of Object.keys(first)) expect(second[key]).toBe(first[key]);
    }, 120_000);

    it(`${project}: the worker pool produces the same bytes as in-process`, async () => {
      const [inProcess, pooled] = [await run(project, "0"), await run(project, "2")];
      expect(Object.keys(pooled).sort()).toEqual(Object.keys(inProcess).sort());
      for (const key of Object.keys(inProcess)) expect(pooled[key]).toBe(inProcess[key]);
    }, 120_000);
  }
});
