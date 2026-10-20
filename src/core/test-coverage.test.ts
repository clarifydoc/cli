import { describe, expect, it } from "vitest";
import { buildTestCoverage, detectFormat, lineRanges, matchReportPath, parseClover, parseCobertura, parseCoverage, parseGoCover, parseJacoco, parseLcov } from "./test-coverage.js";
import type { FileAnalysis } from "../types/analysis.js";

const lines = (hits: Map<string, Map<number, number>>, file: string) => Object.fromEntries(hits.get(file) ?? []);

describe("coverage parsers", () => {
  it("lcov: line hits per record, nothing carried into the next", () => {
    const h = parseLcov("TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\nSF:src/b.ts\nDA:5,3\nend_of_record\nDA:9,9\n");
    expect(lines(h, "src/a.ts")).toEqual({ 1: 1, 2: 0 });
    expect(lines(h, "src/b.ts")).toEqual({ 5: 3 });
    expect(h.size).toBe(2);
  });

  it("Cobertura: classes under the one source root", () => {
    const h = parseCobertura(`<?xml version="1.0" ?><coverage line-rate="0.5"><sources><source>/ci/app</source></sources><packages><package><classes>
      <class name="a" filename="pkg/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class>
    </classes></package></packages></coverage>`);
    expect(lines(h, "/ci/app/pkg/a.py")).toEqual({ 1: 1, 2: 0 });
  });

  it("JaCoCo: package path + source file, covered instructions decide", () => {
    const h = parseJacoco(`<report name="x"><package name="com/acme"><sourcefile name="Orders.java"><line nr="10" mi="0" ci="3"/><line nr="11" mi="2" ci="0"/></sourcefile></package></report>`);
    expect(lines(h, "com/acme/Orders.java")).toEqual({ 10: 3, 11: 0 });
  });

  it("Clover: statements, not the method declaration line", () => {
    const h = parseClover(`<coverage generated="1"><project><file name="A.php" path="/ci/src/A.php"><line num="3" type="method" count="1"/><line num="4" type="stmt" count="0"/></file></project></coverage>`);
    expect(lines(h, "/ci/src/A.php")).toEqual({ 4: 0 });
  });

  it("Go: block ranges expanded, a line run when any block on it ran", () => {
    const h = parseGoCover("mode: set\ngithub.com/acme/app/pkg/x.go:3.10,5.2 2 1\ngithub.com/acme/app/pkg/x.go:5.2,6.3 1 0\n");
    expect(lines(h, "github.com/acme/app/pkg/x.go")).toEqual({ 3: 1, 4: 1, 5: 1, 6: 0 });
  });

  it("tells the formats apart by content", () => {
    expect(detectFormat("mode: atomic\n")).toBe("go");
    expect(detectFormat("TN:\nSF:x\n")).toBe("lcov");
    expect(detectFormat('<?xml version="1.0"?><report name="r"><sessioninfo/>')).toBe("jacoco");
    expect(detectFormat('<coverage generated="1"><project>')).toBe("clover");
    expect(detectFormat('<coverage line-rate="1">')).toBe("cobertura");
    expect(parseCoverage("hello")).toBeNull();
  });
});

describe("matching report paths", () => {
  const index = (files: string[]) => {
    const m = new Map<string, string[]>();
    for (const f of files) {
      const b = f.slice(f.lastIndexOf("/") + 1);
      m.set(b, [...(m.get(b) ?? []), f]);
    }
    return m;
  };
  const files = index(["src/a.ts", "pkg/x.go", "web/src/util.ts", "api/src/util.ts"]);

  it("joins CI paths, module paths and the root's own absolute paths by suffix", () => {
    expect(matchReportPath("/home/runner/work/app/app/src/a.ts", "/repo", files)).toBe("src/a.ts");
    expect(matchReportPath("github.com/acme/app/pkg/x.go", "/repo", files)).toBe("pkg/x.go");
    expect(matchReportPath("/repo/src/a.ts", "/repo", files)).toBe("src/a.ts");
    expect(matchReportPath("C:\\ci\\app\\src\\a.ts", "/repo", files)).toBe("src/a.ts");
  });

  it("refuses a path two files end with equally well", () => {
    expect(matchReportPath("src/util.ts", "/repo", files)).toBeUndefined();
    expect(matchReportPath("/ci/web/src/util.ts", "/repo", files)).toBe("web/src/util.ts");
    expect(matchReportPath("src/missing.ts", "/repo", files)).toBeUndefined();
  });
});

describe("buildTestCoverage", () => {
  it("rolls lines up per file and per function, keeps the uncovered ranges, and flags a stale report", () => {
    const analysis = {
      filePath: "src/a.ts",
      functions: [{ name: "f", line: 1, endLine: 3 }, { name: "g", line: 5, endLine: 7 }],
      classes: [{ name: "C", methods: [{ name: "C.m", line: 9, endLine: 10 }] }],
    } as unknown as FileAnalysis;
    const hits = new Map([["/ci/src/a.ts", new Map([[1, 1], [2, 1], [3, 0], [5, 0], [6, 0], [9, 2]])]]);
    const got = buildTestCoverage([{ file: "coverage/lcov.info", format: "lcov", hits, stale: () => true }], [analysis], "/repo")!;
    expect(got.total).toBe(6);
    expect(got.covered).toBe(3);
    expect(got.files[0]).toMatchObject({ file: "src/a.ts", total: 6, covered: 3, uncovered: "3,5-6" });
    expect(got.files[0]!.functions).toEqual([
      { name: "f", line: 1, endLine: 3, total: 3, covered: 2 },
      { name: "g", line: 5, endLine: 7, total: 2, covered: 0 },
      { name: "C.m", line: 9, endLine: 10, total: 1, covered: 1 },
    ]);
    expect(got.sources).toEqual([{ file: "coverage/lcov.info", format: "lcov", files: 1, matched: 1, stale: true }]);
  });

  it("writes line numbers as compact ranges", () => {
    expect(lineRanges([9, 3, 4, 5, 12, 13, 14, 4])).toBe("3-5,9,12-14");
  });
});

describe("routeTestCoverage", () => {
  it("sums what the tests ran in a route's handler and the functions it calls; a route with none run is untested", async () => {
    const { routeTestCoverage, rangeLines } = await import("./test-coverage.js");
    const link = (sf: string, ss: string, tf: string, ts: string) => ({ sourceFile: sf, sourceSymbol: ss, targetFile: tf, targetSymbol: ts, confidence: "EXTRACTED" });
    const coverage = {
      sources: [], total: 30, covered: 12, unmatched: [],
      files: [
        { file: "routes.ts", total: 10, covered: 6, uncovered: "5-8", functions: [{ name: "list", line: 1, endLine: 9, total: 10, covered: 6 }] },
        { file: "repo.ts", total: 20, covered: 6, uncovered: "", functions: [{ name: "findAll", line: 1, endLine: 9, total: 10, covered: 6 }, { name: "purge", line: 10, endLine: 19, total: 10, covered: 0 }] },
      ],
    };
    const got = routeTestCoverage(
      [
        { filePath: "routes.ts", kind: "api", httpMethod: "GET", path: "/orders" },
        { filePath: "routes.ts", kind: "api", httpMethod: "DELETE", path: "/orders" },
        { filePath: "routes.ts", kind: "frontend", httpMethod: null, path: "/" },
      ],
      [
        link("routes.ts", "route:GET /orders", "routes.ts", "list"),
        link("routes.ts", "list", "repo.ts", "findAll"),
        link("routes.ts", "route:DELETE /orders", "repo.ts", "purge"),
      ],
      coverage as never,
    );
    expect(Object.fromEntries(got)).toEqual({
      "routes.ts\u0000GET /orders": { covered: 12, total: 20, functions: 2 },
      "routes.ts\u0000DELETE /orders": { covered: 0, total: 10, functions: 1 },
    });
    expect(rangeLines("3-5,9")).toEqual([3, 4, 5, 9]);
  });
});
