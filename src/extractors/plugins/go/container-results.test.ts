import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { goContainerResult } from "./syntax.js";
import { goTestCommand } from "./test-command.js";

describe("goContainerResult", () => {
  it("names a slice, array, map or channel result as written, nothing else", () => {
    expect(goContainerResult("[]*Club")).toBe("[]*Club");
    expect(goContainerResult("map[string] *Club")).toBe("map[string]*Club");
    expect(goContainerResult("<-chan *Club")).toBe("<-chan*Club");
    expect(goContainerResult("*Club")).toBeNull();
    expect(goContainerResult("channels.Club")).toBeNull();
  });
});

const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\ngo 1.21\n",
  "club.go": `package league

type Club struct{ Name string }

func (c *Club) Save() error { return nil }

type Garage struct{}

func (g *Garage) Save() error { return nil }

type Source interface {
	All() []*Club
	ByName() map[string]*Club
}

func Load() []*Club           { return nil }
func LoadMap() map[string]*Club { return nil }
func LoadChan() chan *Club    { return nil }
func LoadOne() *Club          { return nil }

func Chained() {
	Load().Save()
	LoadMap().Save()
	LoadChan().Save()
	LoadOne().Save()
}

func LoopSource(s Source) {
	for _, c := range s.All() {
		c.Save()
	}
}

func ChainedSource(s Source) {
	s.All().Save()
	s.ByName().Save()
}
`,
  "shadow.go": `package league

type Car struct{}

func (c *Car) Save() error { return nil }

func ShadowInner(club *Car) {
	{
		club := &Club{}
		club.Save()
	}
}

func ShadowOuter(club *Car) {
	{
		club := &Club{}
		_ = club
	}
	club.Save()
}

func ShadowAssert(club *Car, x any) {
	if club, ok := x.(*Garage); ok {
		club.Save()
	}
}
`,
  "handler.go": `package league

type Handler struct{}

func (h *Handler) Kickoff() {}

func Routes(h *Handler) {
	consume(h.Kickoff)
}

func broken( {
`,
};

describe("Go results that are containers", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-containers-"));
    for (const [rel, text] of Object.entries(FILES)) await writeFile(join(dir, rel), text);
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol);

  it("links a call on a slice, map or channel result to nothing, and on a single value to its class", () => {
    expect(target("Chained", "Load().Save")).toEqual([]);
    expect(target("Chained", "LoadMap().Save")).toEqual([]);
    expect(target("Chained", "LoadChan().Save")).toEqual([]);
    expect(target("Chained", "LoadOne().Save")).toEqual(["Club.Save"]);
  });

  it("does the same for an interface method's container result", () => {
    expect(target("ChainedSource", "s.All().Save")).toEqual([]);
    expect(target("ChainedSource", "s.ByName().Save")).toEqual([]);
  });

  it("types a loop over an interface method's slice result", () => {
    expect(target("LoopSource", "c.Save")).toEqual(["Club.Save"]);
  });

  it("types a call on a parameter's name by the declaration of its own block", () => {
    expect(target("ShadowInner", "club.Save")).toEqual(["Club.Save"]);
    expect(target("ShadowOuter", "club.Save")).toEqual(["Car.Save"]);
    expect(target("ShadowAssert", "club.Save")).toEqual(["Garage.Save"]);
  });

  it("reads method values in a file the ANTLR reading gave up on", async () => {
    const file = JSON.parse(await (await import("fs/promises")).readFile(join(dir, "out", "handler.go.json"), "utf8"));
    expect(file.frontEnd.fallback).toBe("syntax-errors");
    const routes = file.functions.find((f: { name: string }) => f.name === "Routes");
    expect(routes.calls.filter((c: { passed?: string }) => c.passed).map((c: { name: string }) => c.name)).toEqual(["h.Kickoff"]);
  });
});

describe("goTestCommand", () => {
  it("filters each package by its own tests and selects suite methods as subtests", () => {
    expect(goTestCommand([{ file: "a/a_test.go", names: ["TestA"] }, { file: "b/b_test.go", names: [] }])).toBe("go test ./a -run '^(TestA)$' && go test ./b");
    expect(goTestCommand([{ file: "a/a_test.go", names: ["ClubSuite.TestSave", "ClubSuite.SetupTest"] }])).toBe("go test ./a -run '/^(TestSave)$'");
  });
});
