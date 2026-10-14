import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { FILE_ANALYSIS_FIELDS, PROJECT_ANALYSIS_FIELDS, SUMMARY_ENVELOPE, outputSchema } from "./output-schema.js";

const REPO_ROOT = resolve(__dirname, "..", "..");

/**
 * The tables are complete for the TYPES by construction (the typecheck). This
 * checks the other direction: every key an analysis actually writes is one the
 * types — and so `clarifydoc schema` — know about.
 */
describe("clarifydoc schema", () => {
  const summaries = globSync("test-output/*/project-summary.json", { cwd: REPO_ROOT });

  it("lists every key project-summary.json carries", () => {
    expect(summaries.length).toBeGreaterThan(10);
    const unknown = new Set<string>();
    for (const path of summaries) {
      for (const key of Object.keys(JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8")))) {
        if (!(key in PROJECT_ANALYSIS_FIELDS) && !(key in SUMMARY_ENVELOPE)) unknown.add(key);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it("lists every key a per-file JSON carries", () => {
    const perFile = globSync("test-output/*/**/*.json", {
      cwd: REPO_ROOT,
      ignore: ["**/project-summary.json", "**/report-data.json", "**/manifest.json", "**/lsp-*.json", "**/impact-latest.json"],
    }).slice(0, 400);
    expect(perFile.length).toBeGreaterThan(50);
    const unknown = new Set<string>();
    for (const path of perFile) {
      const data = JSON.parse(readFileSync(resolve(REPO_ROOT, path), "utf8"));
      if (!data || typeof data !== "object" || !("filePath" in data)) continue;
      for (const key of Object.keys(data)) if (!(key in FILE_ANALYSIS_FIELDS)) unknown.add(key);
    }
    expect([...unknown]).toEqual([]);
  });

  it("prints required fields apart from optional ones", () => {
    const schema = outputSchema();
    expect(schema.fileAnalysis.required).toContain("filePath");
    expect(schema.fileAnalysis.optional).toContain("diBindings");
    expect(schema.projectAnalysis.required).toContain("routeMap");
  });
});
