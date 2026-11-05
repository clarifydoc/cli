import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { denormalizeProject } from "./element-registry.js";
import { lintAnalysis, type LintFinding } from "./analysis-lint.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

/** `LINT_OUTPUT_DIR` points the gate at a freshly generated set (the committed one lags the extractors between regenerations). */
const OUT = process.env.LINT_OUTPUT_DIR ?? resolve(__dirname, "..", "..", "test-output");

/** The plain loader the fixture tests use: no LSP delta merged (that one can swap in stale symbolLinks). */
function load(dir: string): { project: ProjectAnalysis; files: Map<string, FileAnalysis> } {
  const project = denormalizeProject(JSON.parse(readFileSync(join(dir, "project-summary.json"), "utf-8")));
  const files = new Map<string, FileAnalysis>();
  for (const f of project.files ?? []) {
    const p = join(dir, `${f}.json`);
    if (existsSync(p)) files.set(f, JSON.parse(readFileSync(p, "utf-8")) as FileAnalysis);
  }
  return { project, files };
}

const fixtures = existsSync(OUT) ? readdirSync(OUT).filter((d) => existsSync(join(OUT, d, "project-summary.json"))) : [];

describe("lintAnalysis rules", () => {
  const base = { files: ["a.ts", "b.ts"], subProjects: [{ id: "root" }], fileProjects: { "a.ts": "root" }, routeMap: [], apiCalls: [], symbolLinks: [] } as unknown as ProjectAnalysis;
  const rules = (p: Partial<ProjectAnalysis>) => lintAnalysis({ ...base, ...p }).map((f) => f.rule);

  it("is silent on a consistent summary", () => {
    expect(rules({})).toEqual([]);
  });

  it("flags a file assigned to a missing sub-project", () => {
    expect(rules({ fileProjects: { "a.ts": "ghost" } })).toEqual(["file-project-missing"]);
  });

  it("flags two routes with one identity, not two methods or two projects", () => {
    const r = (o: object) => ({ path: "/clubs", httpMethod: "GET", kind: "api", filePath: "a.ts", line: 1, projectId: "p", ...o });
    expect(rules({ routeMap: [r({}), r({ line: 5 })] as never })).toEqual(["route-duplicate-key"]);
    expect(rules({ routeMap: [r({}), r({ httpMethod: "POST" }), r({ projectId: "q" })] as never })).toEqual([]);
  });

  it("flags an api link whose route or call the summary lacks", () => {
    const link = { source: "a.ts", sourceLine: 3, method: "GET", url: "/clubs", target: "b.ts", targetLine: 1, handler: null, routePath: "/clubs" };
    expect(rules({ apiRouteLinks: [link] as never }).sort()).toEqual(["api-link-call-missing", "api-link-route-missing"]);
    expect(
      rules({
        apiRouteLinks: [link] as never,
        routeMap: [{ path: "/clubs", filePath: "b.ts", line: 1 }] as never,
        apiCalls: [{ filePath: "a.ts", line: 3 }] as never,
      }),
    ).toEqual([]);
  });

  it("flags an entity relation to a missing entity and a screen outside the analysis", () => {
    const graph = { nodes: [{ id: "a.ts::Club", name: "Club", filePath: "a.ts", line: 1 }], edges: [{ source: "a.ts::Club", target: "a.ts::Player" }] };
    expect(rules({ entityGraph: graph as never })).toEqual(["entity-edge-node-missing"]);
    expect(rules({ screens: [{ name: "Table", filePath: "x.ts" }] as never })).toEqual(["screen-file-missing"]);
  });

  it("checks symbol links against the per-file functions and line counts", () => {
    const fa = (o: object) => ({ filePath: "a.ts", functions: [{ name: "play", line: 2, calls: [] }], classes: [], routes: [], dataSources: [], lineCount: 10, ...o }) as unknown as FileAnalysis;
    const link = (o: object) => ({ sourceFile: "a.ts", sourceSymbol: "play", sourceLine: 3, callName: "x", targetFile: "b.ts", targetSymbol: "Club.sign", targetLine: 1, confidence: "EXTRACTED", ...o });
    const files = new Map([["a.ts", fa({})], ["b.ts", fa({ filePath: "b.ts", functions: [], classes: [{ name: "Club", methods: [{ name: "sign", line: 1, calls: [] }] }] })]]);
    expect(lintAnalysis({ ...base, symbolLinks: [link({})] as never }, files)).toEqual([]);
    const bad = lintAnalysis({ ...base, symbolLinks: [link({ sourceSymbol: "ghost", sourceLine: 99, confidence: "SURE", targetFile: "zz.ts" })] as never }, files);
    expect(bad.map((f) => f.rule).sort()).toEqual(["invalid-confidence", "line-out-of-range", "symbol-link-file-missing", "symbol-link-symbol-missing"]);
  });
});

/**
 * Known defects the lint found in today's fixtures that are not fixed yet, as `fixture rule message-prefix`.
 * Empty means every fixture is clean.
 */
const ALLOWED: string[] = [
  // A binary .dfm form is read through a text rendering whose line numbers are synthetic (dfm-binary.ts), so a
  // link into it can name a line past the binary file's physical end. Not small: the viewer would need the rendering.
  "sample-delphi line-out-of-range symbol link <component> -> TAboutBox.btnOKClick",
  // The four below are defects already fixed in the extractors (a call read as an exported definition; a Lisp
  // special variable exported as a function) that the committed outputs still carry until update-fixtures runs.
  "sample-automation-scripts symbol-link-symbol-missing symbol link Init -> TrayTip",
  "sample-automation-scripts symbol-link-symbol-missing symbol link ^!c:: -> TrayTip",
  "sample-automation-scripts export-undefined function export TrayTip",
  "sample-coffee-app export-undefined function export success",
  "sample-grails-app export-undefined function export formatTitle",
  "sample-commonlisp-app export-undefined function export *web*",
];

describe("test-output summaries lint clean", () => {
  const all: Array<LintFinding & { fixture: string }> = [];
  for (const fx of fixtures) {
    const { project, files } = load(join(OUT, fx));
    for (const f of lintAnalysis(project, files)) all.push({ ...f, fixture: fx });
  }
  it("has no finding beyond the allow-list", () => {
    const left = all.filter((f) => !ALLOWED.some((a) => `${f.fixture} ${f.rule} ${f.message}`.startsWith(a)));
    expect(left.map((f) => `${f.fixture} ${f.rule} ${f.message}`)).toEqual([]);
  });
});
