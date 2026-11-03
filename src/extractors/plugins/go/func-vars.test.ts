import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { readGo } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { FileAnalysis, ProjectAnalysis } from "../../../types/analysis.js";
import "../../registry.js";

const CLUBS = `package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

var saveClub = func(name string) {
	db.Exec("INSERT INTO clubs (name) VALUES (?)", name)
	audit(name)
}

var handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
	saveClub(r.FormValue("name"))
})

var (
	parkCar = func(plate string) error {
		return store(plate)
	}
	washCar = func(plate string) { polish(plate) }
	limit   = 10
)

var serviceCar func(string) = func(plate string) { inspect(plate) }

var config = func() string {
	return loadConfig()
}()

var defaultGarage = newGarage("north")

func main() {
	http.Handle("/clubs", handler)
	var local = func() { inspect("inner") }
	local()
}
`;

/** Each function with its span and calls; `<setup>` last. */
function shape(a: FileAnalysis): string[] {
  return a.functions.map((f) => `${f.name} ${f.line}-${f.endLine} [${f.calls.map((c) => c.name).join(", ")}]`);
}

describe("Go package-level function variables", () => {
  const byParse = extractWithRegex(CLUBS, "main.go", "go", undefined, readGo(CLUBS));
  const byPatterns = extractWithRegex(CLUBS, "main.go", "go");

  it("are functions named for the var, holding their literal's calls, on both readings", () => {
    const expected = [
      "saveClub 10-13 [db.Exec, audit]",
      "handler 15-17 [saveClub, r.FormValue]",
      "parkCar 20-22 [store]",
      "washCar 23-23 [polish]",
      "serviceCar 27-27 [inspect]",
      "main 35-39 [http.Handle, inspect, local]",
    ];
    expect(shape(byParse).filter((f) => !f.startsWith("<setup>"))).toEqual(expected);
    expect(shape(byPatterns).filter((f) => !f.startsWith("<setup>"))).toEqual(expected);
  });

  it("take the literal's parameters, never the var's func type", () => {
    for (const a of [byParse, byPatterns]) {
      const params = (name: string) => a.functions.find((f) => f.name === name)!.params.map((p) => `${p.name}:${p.type}`);
      expect(params("handler")).toEqual(["w:http.ResponseWriter", "r:http.Request"]);
      expect(params("serviceCar")).toEqual(["plate:string"]);
    }
  });

  it("leave other package-level initializers to <setup>: one invoked on the spot, one calling a constructor", () => {
    const setup = (a: FileAnalysis) => a.functions.find((f) => f.name === "<setup>")!.calls.map((c) => c.name);
    expect(setup(byParse)).toEqual(["http.HandlerFunc", "loadConfig", "newGarage"]);
    // The patterns read lines: the wrapper on the function variable's own line is in neither.
    expect(setup(byPatterns)).toEqual(["loadConfig", "newGarage"]);
  });

  it("read nothing of a grouped declaration's keyword as a call", () => {
    const calls = byPatterns.functions.flatMap((f) => f.calls.map((c) => c.name));
    expect(calls).not.toContain("import");
    expect(calls).not.toContain("var");
  });
});

/** A route served by a function variable reaches the table its body writes; a method of the same name is another. */
const PROJECT: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.21\n",
  "main.go": CLUBS + `
func audit(name string)                  {}
func store(plate string) error           { return nil }
func polish(plate string)                {}
func inspect(plate string)               {}
func loadConfig() string                 { return "" }
func newGarage(name string) string       { return name }
`,
  "stadium.go": `package main

type Stadium struct{}

func (s *Stadium) saveClub(name string) {
	db.Exec("UPDATE stadiums SET name = ?", name)
}
`,
};

describe("a route served by a package-level function variable", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-func-vars-"));
    for (const [rel, text] of Object.entries(PROJECT)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reaches the table the variable's body writes, through the variable it calls", () => {
    const reach = (summary.symbolReach ?? []).find((r) => r.symbol === "route:USE /clubs");
    expect(reach?.effects.map((e) => `${e.kind} ${e.resource}`)).toEqual(["db-write clubs"]);
    const links = (summary.symbolLinks ?? []).filter((l) => l.sourceSymbol === "handler").map((l) => `${l.targetFile}::${l.targetSymbol}`);
    expect(links).toEqual(["main.go::saveClub"]);
  });
});
