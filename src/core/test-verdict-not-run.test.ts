/**
 * The file test verdict leaves out what a test run does not run: a module a test replaces with a
 * double (`vi.mock`, `jest.mock`), and a file a build for the default target leaves out (a Go
 * `//go:build windows` file, which a test of its package does not compile on Linux).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import { fileTestVerdict, testVerdictContext } from "./test-functions.js";
import type { FileAnalysis, ProjectAnalysis } from "../types/analysis.js";

let dir = "";
const files: Record<string, string> = {
  // A web client whose store tests replace its API module.
  "web/package.json": JSON.stringify({ name: "league-web", devDependencies: { vitest: "^2.0.0" } }),
  "web/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }),
  "web/src/api/clubs.ts": [
    "export async function getClubs(league: string): Promise<string[]> {",
    "  const res = await fetch(`/api/v2/leagues/${league}/clubs`);",
    "  return res.json();",
    "}",
  ].join("\n"),
  "web/src/api/players.ts": [
    "export async function getPlayers(club: string): Promise<string[]> {",
    "  const res = await fetch(`/api/v2/clubs/${club}/players`);",
    "  return res.json();",
    "}",
    "export function playerLabel(name: string): string {",
    "  return name.toUpperCase();",
    "}",
  ].join("\n"),
  "web/src/store/clubs.ts": [
    'import { getClubs } from "@/api/clubs";',
    "export const actions = {",
    "  async load(league: string): Promise<string[]> {",
    "    return getClubs(league);",
    "  },",
    "};",
  ].join("\n"),
  "web/src/store/clubs.spec.ts": [
    'import { describe, it, expect, vi } from "vitest";',
    'import { actions } from "./clubs";',
    'import { getClubs } from "@/api/clubs";',
    'vi.mock("@/api/clubs");',
    'describe("clubs store", () => {',
    '  it("loads the clubs", async () => {',
    '    getClubs.mockReturnValue(["Rovers"]);',
    '    expect(await actions.load("north")).toEqual(["Rovers"]);',
    "    expect(getClubs).toHaveBeenCalled();",
    "  });",
    "});",
  ].join("\n"),
  // A partial mock keeps the module's own functions: the module still runs.
  "web/src/api/players.spec.ts": [
    'import { describe, it, expect, vi } from "vitest";',
    'import { playerLabel } from "./players";',
    'vi.mock("./players", async (importOriginal) => ({ ...(await importOriginal()), getPlayers: vi.fn() }));',
    'describe("players", () => {',
    '  it("labels", () => {',
    '    expect(playerLabel("kane")).toBe("KANE");',
    "  });",
    "});",
  ].join("\n"),
  // A module reached only through a module the test replaces: the double runs, never what lies below it.
  "web/src/api/standings.ts": [
    "export async function getStandings(league: string): Promise<number[]> {",
    "  const res = await fetch(`/api/v2/leagues/${league}/standings`);",
    "  return res.json();",
    "}",
  ].join("\n"),
  "web/src/store/standings.ts": [
    'import { getStandings } from "@/api/standings";',
    "export function loadStandings(league: string): Promise<number[]> {",
    "  return getStandings(league);",
    "}",
  ].join("\n"),
  "web/src/store/season.ts": [
    'import { loadStandings } from "./standings";',
    "export async function seasonPoints(league: string): Promise<number> {",
    "  return (await loadStandings(league)).length;",
    "}",
  ].join("\n"),
  "web/src/store/season.spec.ts": [
    'import { describe, it, expect, vi } from "vitest";',
    'import { seasonPoints } from "./season";',
    'vi.mock("./standings", () => ({ loadStandings: async () => [3, 1] }));',
    'describe("season", () => {',
    '  it("counts", async () => {',
    '    expect(await seasonPoints("north")).toBe(2);',
    "  });",
    "});",
  ].join("\n"),
  // A Go package with a file only Windows builds compile.
  "svc/go.mod": "module example.com/garage\n\ngo 1.22\n",
  "svc/garage/garage.go": ["package garage", "", "func ParkCar(bay int) int {", "\treturn bay + 1", "}", ""].join("\n"),
  "svc/garage/diagnostics_windows.go": [
    "//go:build windows",
    "",
    "package garage",
    "",
    "func diskSpace(path string) int {",
    "\treturn len(path)",
    "}",
    "",
  ].join("\n"),
  "svc/garage/diagnostics_unix.go": [
    "//go:build !windows",
    "",
    "package garage",
    "",
    "func diskSpace(path string) int {",
    "\treturn len(path) * 2",
    "}",
    "",
  ].join("\n"),
  "svc/garage/lift_darwin.go": ["package garage", "", "func liftHeight() int {", "\treturn 3", "}", ""].join("\n"),
  // A test of another package loads this one for its side effects: it depends on every file the package compiles.
  "svc/bays/bays_test.go": [
    "package bays",
    "",
    "import (",
    '\t"testing"',
    "",
    '\t_ "example.com/garage/garage"',
    ")",
    "",
    "func TestBay(t *testing.T) {",
    '\tt.Log("bay")',
    "}",
    "",
  ].join("\n"),
  "svc/garage/garage_test.go": [
    "package garage",
    "",
    'import "testing"',
    "",
    "func TestParkCar(t *testing.T) {",
    "\tif ParkCar(1) != 2 {",
    '\t\tt.Fatal("wrong bay")',
    "\t}",
    "}",
    "",
  ].join("\n"),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "clarifydoc-verdict-not-run-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
    await writeFile(join(dir, "app", rel), text);
  }
  await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
}, 180_000);
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function verdictOf(path: string): Promise<{ state: string; basis: string[] }> {
  const summary: ProjectAnalysis = await loadReportSummary(join(dir, "out"));
  const file = JSON.parse(await readFile(join(dir, "out", `${path}.json`), "utf-8")) as FileAnalysis;
  const v = fileTestVerdict(summary, path, file, testVerdictContext(summary));
  return { state: v.state, basis: v.basis };
}

describe("test verdict: what a test run does not run", () => {
  it("does not count a test that replaces the module with a double, by import or by call", async () => {
    expect(await verdictOf("web/src/api/clubs.ts")).toEqual({ state: "untested", basis: [] });
    // The store the same test drives is tested.
    expect((await verdictOf("web/src/store/clubs.ts")).state).toBe("tested");
  });

  it("does not count a test for what lies below a module it replaces, through a third module", async () => {
    expect(await verdictOf("web/src/api/standings.ts")).toEqual({ state: "untested", basis: [] });
    expect((await verdictOf("web/src/store/season.ts")).state).toBe("tested");
  });

  it("counts a partial mock, which keeps the module's own functions", async () => {
    expect(await verdictOf("web/src/api/players.ts")).toEqual({ state: "tested", basis: ["importer", "reached-function"] });
  });

  it("does not count a test of the package for a file only another platform's build compiles", async () => {
    expect(await verdictOf("svc/garage/diagnostics_windows.go")).toEqual({ state: "untested", basis: [] });
    expect(await verdictOf("svc/garage/lift_darwin.go")).toEqual({ state: "untested", basis: [] });
    expect(await verdictOf("svc/garage/diagnostics_unix.go")).toEqual({ state: "tested", basis: ["importer"] });
    expect((await verdictOf("svc/garage/garage.go")).state).toBe("tested");
  });
});
