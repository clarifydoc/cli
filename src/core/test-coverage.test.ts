import { describe, expect, it } from "vitest";
import { aggregateOnlyNote, buildTestCoverage, detectFormat, lineRanges, matchReportPath, parallelCoverageFiles, parseClover, parseCobertura, parseCoverage, parseGoCover, parseJacoco, parseLcov, perTestSources } from "./test-coverage.js";
import type { FileAnalysis } from "../types/analysis.js";

const lines = (hits: Map<string, Map<number, number>>, file: string) => Object.fromEntries(hits.get(file) ?? []);
const runs = (tests: Map<string, Map<string, Set<number>>> | undefined, file: string) =>
  Object.fromEntries([...(tests?.get(file) ?? [])].map(([id, ls]) => [id, [...ls].sort((a, b) => a - b)]));

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
    const h = parseJacoco(`<report name="x"><package name="com/acme"><sourcefile name="Cars.java"><line nr="10" mi="0" ci="3"/><line nr="11" mi="2" ci="0"/></sourcefile></package></report>`);
    expect(lines(h, "com/acme/Cars.java")).toEqual({ 10: 3, 11: 0 });
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
    expect(got.sources).toEqual([{ file: "coverage/lcov.info", format: "lcov", files: 1, matched: 1, stale: true, tests: 0 }]);
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
        { filePath: "routes.ts", kind: "api", httpMethod: "GET", path: "/cars" },
        { filePath: "routes.ts", kind: "api", httpMethod: "DELETE", path: "/cars" },
        { filePath: "routes.ts", kind: "frontend", httpMethod: null, path: "/" },
      ],
      [
        link("routes.ts", "route:GET /cars", "routes.ts", "list"),
        link("routes.ts", "list", "repo.ts", "findAll"),
        link("routes.ts", "route:DELETE /cars", "repo.ts", "purge"),
      ],
      coverage as never,
    );
    expect(Object.fromEntries(got)).toEqual({
      "routes.ts\u0000GET /cars": { covered: 12, total: 20, functions: 2 },
      "routes.ts\u0000DELETE /cars": { covered: 0, total: 10, functions: 1 },
    });
    expect(rangeLines("3-5,9")).toEqual([3, 4, 5, 9]);
  });
});

describe("per-test coverage contexts", () => {
  // A coverage.py JSON report written with `--show-contexts` after `pytest --cov --cov-context=test`, trimmed to one file.
  const coveragePyJson = (contexts: boolean) => JSON.stringify({
    meta: { format: 3, version: "7.10.7", branch_coverage: false, show_contexts: contexts },
    files: {
      "app/club.py": {
        executed_lines: [1, 2, 3, 6, 7, 10, 11, 17, 18],
        missing_lines: [12],
        excluded_lines: [],
        ...(contexts
          ? {
              contexts: {
                "1": [""], "2": [""], "6": [""], "10": [""], "17": [""],
                "3": ["tests/test_club.py::TestClub::test_sign|run", "tests/test_club.py::test_rank|run"],
                "7": ["tests/test_club.py::TestClub::test_sign|run", "tests/test_club.py::TestClub::test_release|setup"],
                "11": ["tests/test_club.py::TestClub::test_release|run"],
                "18": ["tests/test_club.py::test_rank|run"],
              },
            }
          : {}),
      },
    },
  });

  it("lcov: TN names a test when at least two distinct names appear; one name or a blank one is aggregate-only", () => {
    const perTest = parseCoverage("TN:test_sign\nSF:app/club.py\nDA:3,1\nDA:7,1\nDA:11,0\nend_of_record\nTN:test_release\nSF:app/club.py\nDA:3,1\nDA:11,2\nend_of_record\n")!;
    expect(perTest.format).toBe("lcov");
    expect(lines(perTest.hits, "app/club.py")).toEqual({ 3: 1, 7: 1, 11: 2 });
    expect(runs(perTest.tests, "app/club.py")).toEqual({ test_sign: [3, 7], test_release: [3, 11] });
    expect(parseCoverage("TN:all\nSF:app/club.py\nDA:3,1\nend_of_record\nTN:all\nSF:app/rank.py\nDA:1,1\nend_of_record\n")!.tests).toBeUndefined();
    expect(parseCoverage("TN:\nSF:app/club.py\nDA:3,1\nend_of_record\n")!.tests).toBeUndefined();
  });

  it("coverage.py JSON: executed and missing lines, and each line's contexts with the phase suffix and the empty context dropped", () => {
    expect(detectFormat(coveragePyJson(true))).toBe("coveragepy-json");
    const got = parseCoverage(coveragePyJson(true))!;
    expect(lines(got.hits, "app/club.py")).toEqual({ 1: 1, 2: 1, 3: 1, 6: 1, 7: 1, 10: 1, 11: 1, 12: 0, 17: 1, 18: 1 });
    expect(runs(got.tests, "app/club.py")).toEqual({
      "tests/test_club.py::TestClub::test_sign": [3, 7],
      "tests/test_club.py::TestClub::test_release": [7, 11],
      "tests/test_club.py::test_rank": [3, 18],
    });
    // Without --show-contexts the same report is aggregate-only.
    expect(parseCoverage(coveragePyJson(false))!.tests).toBeUndefined();
    // Another tool's JSON is not coverage.py's.
    expect(detectFormat(JSON.stringify({ "src/a.ts": { statementMap: {} } }))).toBeNull();
  });

  it("joins each test to the functions it ran, as the marked test function when the analysis has it, else the raw id", () => {
    const source = {
      filePath: "app/club.py",
      functions: [{ name: "rank", line: 17, endLine: 18 }],
      classes: [{ name: "Club", methods: [{ name: "sign", line: 6, endLine: 8 }, { name: "release", line: 10, endLine: 14 }] }],
    } as unknown as FileAnalysis;
    const testFile = {
      filePath: "tests/test_club.py",
      functions: [{ name: "test_rank", line: 15, endLine: 16, testCase: { kind: "case", title: "test_rank", path: [] } }],
      classes: [{ name: "TestClub", methods: [{ name: "test_sign", line: 5, endLine: 7, testCase: { kind: "case", title: "test_sign", path: ["TestClub"] } }] }],
    } as unknown as FileAnalysis;
    const parsed = parseCoverage(coveragePyJson(true))!;
    const got = buildTestCoverage([{ file: "coverage.json", ...parsed, stale: () => false }], [source, testFile], "/repo")!;
    const fns = Object.fromEntries(got.files[0]!.functions!.map((f) => [f.name, { tests: (f.tests ?? []).map((i) => got.tests![i]), count: f.testCount }]));
    expect(fns.sign).toEqual({
      tests: [
        { id: "tests/test_club.py::TestClub::test_release", file: "tests/test_club.py", symbol: "TestClub.test_release" },
        { id: "tests/test_club.py::TestClub::test_sign", file: "tests/test_club.py", symbol: "TestClub.test_sign", line: 5 },
      ],
      count: 2,
    });
    expect(fns.rank).toEqual({ tests: [{ id: "tests/test_club.py::test_rank", file: "tests/test_club.py", symbol: "test_rank", line: 15 }], count: 1 });
    expect(got.sources[0]).toMatchObject({ file: "coverage.json", format: "coveragepy-json", tests: 3 });
    expect(aggregateOnlyNote(got)).toBeUndefined();
    expect(perTestSources(got)).toEqual(["coverage.json"]);
  });

  it("reads dotted context names and keeps an id naming no analyzed file as written", () => {
    const source = { filePath: "app/club.py", functions: [{ name: "rank", line: 17, endLine: 18 }], classes: [] } as unknown as FileAnalysis;
    const testFile = { filePath: "tests/test_club.py", functions: [{ name: "test_rank", line: 15, endLine: 16, testCase: { kind: "case", title: "test_rank", path: [] } }], classes: [] } as unknown as FileAnalysis;
    const tests = new Map([["app/club.py", new Map([["tests.test_club.test_rank", new Set([18])], ["e2e/flows.spec::cup final", new Set([17, 18])]])]]);
    const got = buildTestCoverage([{ file: ".coverage", format: "coveragepy-db", hits: new Map(), tests, stale: () => false }], [source, testFile], "/repo")!;
    const fn = got.files[0]!.functions![0]!;
    expect(fn).toMatchObject({ name: "rank", total: 0, covered: 0, testCount: 2 });
    expect(fn.tests!.map((i) => got.tests![i])).toEqual([
      { id: "e2e/flows.spec::cup final" },
      { id: "tests.test_club.test_rank", file: "tests/test_club.py", symbol: "test_rank", line: 15 },
    ]);
    // A ran-lines-only report states no executable lines: no percentage.
    expect(got.files[0]).toMatchObject({ total: 0, covered: 0 });
  });

  it("keeps the tests that ran most of a function, at most twelve, and counts the rest", () => {
    const source = { filePath: "app/garage.py", functions: [{ name: "park", line: 1, endLine: 10 }], classes: [] } as unknown as FileAnalysis;
    const perTest = new Map<string, Set<number>>();
    for (let i = 0; i < 30; i++) perTest.set(`tests/test_garage.py::test_park_${String(i).padStart(2, "0")}`, new Set(i === 29 ? [1, 2, 3, 4] : [2]));
    const got = buildTestCoverage([{ file: "coverage.json", format: "coveragepy-json", hits: new Map([["app/garage.py", new Map([[2, 1]])]]), tests: new Map([["app/garage.py", perTest]]), stale: () => false }], [source], "/repo")!;
    const fn = got.files[0]!.functions![0]!;
    expect(fn.testCount).toBe(30);
    expect(fn.tests).toHaveLength(12);
    expect(got.tests![fn.tests![0]!]!.id).toBe("tests/test_garage.py::test_park_29");
    // Only the tests a function keeps are in the table.
    expect(got.tests).toHaveLength(12);
  });

  it("says once that a report without test contexts is aggregate-only", () => {
    const source = { filePath: "src/a.ts", functions: [{ name: "f", line: 1, endLine: 3 }], classes: [] } as unknown as FileAnalysis;
    const got = buildTestCoverage([{ file: "coverage.xml", format: "cobertura", hits: new Map([["src/a.ts", new Map([[1, 1]])]]), stale: () => false }], [source], "/repo")!;
    expect(got.sources[0]!.tests).toBe(0);
    expect(aggregateOnlyNote(got)).toBe("coverage.xml records no test contexts (aggregate-only): it says a line ran, never which test ran it");
    expect(perTestSources(got)).toEqual([]);
    // A summary written before contexts were read says nothing either way.
    expect(aggregateOnlyNote({ ...got, sources: [{ file: "lcov.info", format: "lcov", files: 1, matched: 1, stale: false }] })).toBeUndefined();
  });
});

// node:sqlite needs Node 22.13 or later; without it these skip, and the reader says why instead (the last case).
const sqlite = await import("node:sqlite").catch(() => undefined);

describe("coverage.py data file", () => {
  const withSqlite = sqlite ? it : it.skip;

  const numbits = (ls: number[]) => {
    const bytes = new Uint8Array(Math.max(...ls) / 8 + 1);
    for (const n of ls) bytes[n >> 3]! |= 1 << (n & 7);
    return bytes;
  };
  const makeDb = async (rows: { contexts: string[]; lines?: Array<[number, number, number[]]>; arcs?: Array<[number, number, number, number]> }) => {
    const { mkdtemp } = await import("fs/promises");
    const { tmpdir } = await import("os");
    const { join } = await import("path");
    const path = join(await mkdtemp(join(tmpdir(), "clarifydoc-coverage-db-")), ".coverage");
    const db = new sqlite!.DatabaseSync(path);
    db.exec(`CREATE TABLE coverage_schema (version integer); INSERT INTO coverage_schema VALUES (7);
      CREATE TABLE meta (key text, value text, unique (key)); INSERT INTO meta VALUES ('has_arcs', '${rows.arcs ? 1 : 0}');
      CREATE TABLE file (id integer primary key, path text, unique (path));
      CREATE TABLE context (id integer primary key, context text, unique (context));
      CREATE TABLE line_bits (file_id integer, context_id integer, numbits blob, unique (file_id, context_id));
      CREATE TABLE arc (file_id integer, context_id integer, fromno integer, tono integer, unique (file_id, context_id, fromno, tono));
      INSERT INTO file VALUES (1, '/ci/league/app/club.py');`);
    rows.contexts.forEach((c, i) => db.prepare("INSERT INTO context VALUES (?, ?)").run(i + 1, c));
    for (const [f, c, ls] of rows.lines ?? []) db.prepare("INSERT INTO line_bits VALUES (?, ?, ?)").run(f, c, numbits(ls));
    for (const [f, c, a, b] of rows.arcs ?? []) db.prepare("INSERT INTO arc VALUES (?, ?, ?, ?)").run(f, c, a, b);
    db.close();
    return path;
  };

  withSqlite("reads the lines each test context ran from line bits", async () => {
    const { readCoverageDb } = await import("./test-coverage.js");
    const path = await makeDb({
      contexts: ["", "tests/test_club.py::TestClub::test_sign|run", "tests/test_club.py::TestClub::test_sign|setup", "tests/test_club.py::test_rank|run"],
      lines: [[1, 1, [1, 2, 6, 10, 17]], [1, 2, [3, 7, 8]], [1, 3, [3]], [1, 4, [3, 18]]],
    });
    const got = await readCoverageDb(path);
    expect("unread" in got).toBe(false);
    if ("unread" in got) return;
    expect(got.format).toBe("coveragepy-db");
    expect(got.hits.size).toBe(0);
    expect(runs(got.tests, "/ci/league/app/club.py")).toEqual({
      "tests/test_club.py::TestClub::test_sign": [3, 7, 8],
      "tests/test_club.py::test_rank": [3, 18],
    });
  });

  withSqlite("reads arcs in branch mode, and a db whose only context is the empty one has no test dimension", async () => {
    const { readCoverageDb } = await import("./test-coverage.js");
    const arcs = await makeDb({ contexts: ["", "tests.test_club.test_rank"], arcs: [[1, 2, -17, 18], [1, 2, 18, -17], [1, 1, 1, 2]] });
    const got = await readCoverageDb(arcs);
    expect("unread" in got ? got.unread : runs(got.tests, "/ci/league/app/club.py")).toEqual({ "tests.test_club.test_rank": [18] });
    const plain = await readCoverageDb(await makeDb({ contexts: [""], lines: [[1, 1, [1, 2, 3]]] }));
    expect("unread" in plain ? plain.unread : plain.tests).toBeUndefined();
  });

  it("says why a file it cannot open was not read", async () => {
    const { readCoverageDb } = await import("./test-coverage.js");
    const got = await readCoverageDb("/no/such/dir/.coverage");
    expect("unread" in got && got.unread).toMatch(/node:sqlite|could not be read/);
  });
});

describe("parallel coverage data files", () => {
  it("names `.coverage.<host>.<pid>.<random>` beside the combined file, and nothing else", () => {
    const entries = [".coverage", ".coverage.pitch-01.4321.XkQ3v9", ".coverage.club.example.net.77.a_b2", ".coverage.xml", ".coveragerc", "coverage.json", ".coverage.lock"];
    expect(parallelCoverageFiles("/repo/", entries)).toEqual(["/repo/.coverage.club.example.net.77.a_b2", "/repo/.coverage.pitch-01.4321.XkQ3v9"]);
  });
});
