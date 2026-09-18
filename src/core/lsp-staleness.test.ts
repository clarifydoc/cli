import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadReportSummary } from "./report-payload.js";

/**
 * `analyze` never refreshes or removes `lsp-enhancement.json`, so a plain
 * re-run leaves an older delta beside a newer summary. Merging it by presence
 * replaced the fresh graphs with ones describing code that had since changed —
 * and because `analyze --html` renders through `loadReportSummary`, the stale
 * graph reached the very report.html that run had just written.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clarifydoc-lsp-stale-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BASE_LINK = {
  sourceFile: "a.ts", sourceSymbol: "a", sourceLine: 1,
  callName: "fresh", targetFile: "b.ts", targetSymbol: "b", targetLine: 1,
};
const LSP_LINK = { ...BASE_LINK, callName: "fromLsp" };

function writeAnalysis(analyzedAt: string, enhancedAt: string | undefined): void {
  writeFileSync(join(dir, "project-summary.json"), JSON.stringify({
    projectRoot: "/x", detectedFrameworks: [], subProjects: [], fileProjects: {},
    files: ["a.ts", "b.ts"], componentGraph: { "a.ts": ["b.ts"] }, linkGraph: [],
    interactiveElements: [], events: [], routeMap: [], apiCalls: [], screens: [],
    symbolLinks: [BASE_LINK], analyzedAt,
  }));
  writeFileSync(join(dir, "lsp-enhancement.json"), JSON.stringify({
    symbolLinks: [LSP_LINK],
    componentGraph: { "a.ts": ["b.ts", "c.ts"] },
    linkGraph: [],
    blastRadius: [],
    lspStats: { serversUsed: ["tsserver"], lspResolvedCount: 7, referenceLinksCount: 2, enhancementTimeMs: 10 },
    ...(enhancedAt ? { enhancedAt } : {}),
  }));
}

describe("loadReportSummary — LSP delta age guard", () => {
  it("refuses a delta older than the analysis and says so", async () => {
    writeAnalysis("2026-05-02T00:00:00.000Z", "2026-05-01T00:00:00.000Z");
    const s = await loadReportSummary(dir);
    expect(s.symbolLinks.map((l) => l.callName)).toEqual(["fresh"]);
    expect(s.componentGraph["a.ts"]).toEqual(["b.ts"]);
    expect(s.lspStats?.stale).toBe(true);
    expect(s.lspStats?.enhancedAt).toBe("2026-05-01T00:00:00.000Z");
  });

  it("merges a delta newer than the analysis and records when it was made", async () => {
    writeAnalysis("2026-05-01T00:00:00.000Z", "2026-05-02T00:00:00.000Z");
    const s = await loadReportSummary(dir);
    expect(s.symbolLinks.map((l) => l.callName)).toEqual(["fromLsp"]);
    expect(s.componentGraph["a.ts"]).toEqual(["b.ts", "c.ts"]);
    expect(s.lspStats?.stale).toBeUndefined();
    expect(s.lspStats?.enhancedAt).toBe("2026-05-02T00:00:00.000Z");
  });

  it("merges a delta with no timestamp, as before — absence is not evidence of staleness", async () => {
    writeAnalysis("2026-05-01T00:00:00.000Z", undefined);
    const s = await loadReportSummary(dir);
    expect(s.symbolLinks.map((l) => l.callName)).toEqual(["fromLsp"]);
    expect(s.lspStats?.stale).toBeUndefined();
  });
});
