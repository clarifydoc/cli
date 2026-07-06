import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { generateHtmlReport } from "../html-report.js";

// End-to-end smoke test: neither tsc nor the fragment guards execute the emitted
// client bundle, so this drives generateHtmlReport against a minimal analysis and
// asserts the document is complete and the full client bundle is emitted in order.

describe("generateHtmlReport — smoke", () => {
  let dir: string;
  let html: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "revdoc-report-"));
    const summary = {
      projectRoot: "/tmp/demo",
      analyzedAt: new Date(0).toISOString(),
      detectedFrameworks: [],
      files: [],
      routeMap: [],
      apiCalls: [],
    };
    await writeFile(join(dir, "project-summary.json"), JSON.stringify(summary), "utf-8");
    const outPath = join(dir, "report.html");
    await generateHtmlReport({ analysisDir: dir, outputPath: outPath, openBrowser: false });
    html = await readFile(outPath, "utf-8");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("emits a complete HTML document", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("embeds the DATA payload and the full client bundle, first-to-last", () => {
    const dataAt = html.indexOf("const DATA = ");
    const firstStmt = html.indexOf("function requestRender"); // early: runtime fragment
    const lastStmt = html.indexOf("syncTabFromHash();"); // last: report-tabs fragment
    expect(dataAt).toBeGreaterThanOrEqual(0);
    expect(firstStmt).toBeGreaterThan(dataAt);
    expect(lastStmt).toBeGreaterThan(firstStmt);
  });

  it("has balanced, terminated <script> tags (no unterminated template literal)", () => {
    const open = (html.match(/<script/g) || []).length;
    const close = (html.match(/<\/script>/g) || []).length;
    expect(open).toBe(close);
    expect(open).toBeGreaterThanOrEqual(2); // d3 CDN + inline bundle
  });

  it("renders the summary tab shell", () => {
    expect(html).toContain('id="view-summary"');
  });
});
