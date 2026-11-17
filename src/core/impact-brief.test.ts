import { describe, it, expect } from "vitest";
import { computeImpactDiff, renderImpactBrief, renderImpactMarkdown, renderImpactText, reviewPriorities } from "./impact-diff.js";
import type { ProjectAnalysis } from "../types/analysis.js";

const link = (sf: string, ss: string, tf: string, ts: string, line = 1) =>
  ({ sourceFile: sf, sourceSymbol: ss, sourceLine: line, callName: ts, targetFile: tf, targetSymbol: ts, targetLine: 1, confidence: "EXTRACTED" });

const summary = {
  files: ["srv/club.ts", "srv/routes.ts", "srv/jobs.ts", "srv/club.test.ts", "srv/player.ts"],
  componentGraph: {},
  routeMap: [],
  blastRadius: [],
  symbolLinks: [
    link("srv/routes.ts", "route:POST /clubs", "srv/club.ts", "signPlayer", 3),
    link("srv/jobs.ts", "nightly", "srv/club.ts", "signPlayer", 9),
    link("srv/routes.ts", "listClubs", "srv/club.ts", "signPlayer", 12),
    link("srv/club.test.ts", "test_sign", "srv/club.ts", "signPlayer", 4),
    link("srv/jobs.ts", "weekly", "srv/club.ts", "transfer", 20),
  ],
} as unknown as ProjectAnalysis;

const changed = [
  { file: "srv/club.ts", symbol: "signPlayer", line: 10, endLine: 30 },
  { file: "srv/club.ts", symbol: "transfer", line: 40, endLine: 50 },
  { file: "srv/club.ts", symbol: "release", line: 60, endLine: 70 },
  { file: "srv/player.ts", symbol: "retire", line: 5, endLine: 9 },
];

describe("impact --brief: review priorities", () => {
  const r = computeImpactDiff(summary, ["srv/club.ts", "srv/player.ts"], { symbols: { changed, moduleLevel: [] } });

  it("names exactly three priorities, the riskiest first, each with file:line, risk, callers and tests", () => {
    const top = reviewPriorities(summary, r);
    expect(top).toHaveLength(3);
    expect(top[0]).toMatchObject({ symbol: "signPlayer", file: "srv/club.ts", line: 10, risk: "high", routes: 1 });
    expect(top[0]!.callers).toBe(2);
    expect(top[0]!.tests.map((t) => t.symbol)).toEqual(["test_sign"]);
    const text = renderImpactBrief(r, top);
    expect(text).toContain("1. HIGH  srv/club.ts:10  signPlayer");
    expect(text).toContain("2 caller(s); tests: test_sign (srv/club.test.ts:4)");
    expect(text).toContain("tests: none");
    expect(text.match(/^\d\. /gm)).toHaveLength(3);
    expect(renderImpactBrief(r, top, true)).toContain("1. **HIGH** `srv/club.ts:10`");
  });

  it("puts a breaking signature change ahead of everything", () => {
    const withBreak = computeImpactDiff(summary, ["srv/player.ts"], {
      symbols: { changed, moduleLevel: [], signatureChanges: [{ file: "srv/player.ts", symbol: "retire", line: 5, kind: "arity", before: 1, after: 2, callers: 0, breaking: true } as never] },
    });
    expect(reviewPriorities(summary, withBreak)[0]).toMatchObject({ symbol: "retire", risk: "high" });
  });
});

describe("limitations in the impact report", () => {
  it("lists what could not be judged and renders it in both renderers", () => {
    const r = computeImpactDiff(summary, ["srv/club.ts", "docs/new-file.ts"], {});
    expect(r.limitations).toEqual([expect.stringContaining("1 changed file(s) are not in the analysis (docs/new-file.ts)")]);
    expect(renderImpactText(r)).toContain("Could not judge:\n  - 1 changed file(s) are not in the analysis");
    expect(renderImpactMarkdown(r)).toContain("**Could not judge**");
    expect(renderImpactBrief(r, reviewPriorities(summary, r))).toContain("Could not judge:");
  });

  it("is absent when nothing was left out", () => {
    const r = computeImpactDiff(summary, ["srv/club.ts"], {});
    expect(r.limitations).toBeUndefined();
    expect(renderImpactText(r)).not.toContain("Could not judge");
  });

  it("reports a coverage report that names no tests", () => {
    const cov = { ...summary, testCoverage: { files: [{ file: "srv/club.ts", total: 4, covered: 2 }], sources: [{ file: "lcov.info", tests: 0 }] } } as unknown as ProjectAnalysis;
    const r = computeImpactDiff(cov, ["srv/club.ts"], {});
    expect(r.coverageNote).toBeDefined();
    expect(r.limitations?.some((l) => l.startsWith("no per-test evidence: lcov.info records"))).toBe(true);
  });
});
