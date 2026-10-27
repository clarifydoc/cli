import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A Go import names a package by its go.mod module path plus its directory:
 * resolved exactly, two directories named alike never compete, the standard
 * library is no project package, and a `replace` to a local directory is that
 * directory. A package.json at the root names the project first (real-repo shape).
 */
const FILES: Record<string, string> = {
  "package.json": `{ "name": "league-web", "version": "1.0.0" }\n`,
  "go.mod": "module example.com/league\n\ngo 1.22\n\nrequire example.com/garage v0.0.0\n\nreplace example.com/garage => ./garage\n",
  "garage/go.mod": "module garage-local\n\ngo 1.22\n",
  "garage/cars/car.go": `package cars

type Car struct {
	Plate string
}

func NewCar(plate string) *Car {
	return &Car{Plate: plate}
}

`,
  "internal/fleet/van.go": `package fleet

type Van struct {
	Plate string
}

func (v *Van) Park() error {
	return nil
}

func (v *Van) Cut() {}

func (v *Van) Header(name string) string {
	return name
}

type Vans []*Van

func (l Vans) Inspect() int {
	return len(l)
}
`,
  "internal/standings/table.go": `package standings

func Table() []string {
	return nil
}
`,
  "tools/standings/table.go": `package standings

func Table() []string {
	return nil
}
`,
  "internal/log/log.go": `package log

func Printf(format string, args ...any) {}
`,
  "internal/referee/referee.go": `package referee

type Referee struct{}

func (r *Referee) Whistle() {}
`,
  // The import of the fleet package sits in a sibling file of the package.
  "internal/api/deps.go": `package api

import "example.com/league/internal/fleet"

var Fleet []*fleet.Van
`,
  "internal/api/clubs.go": `package api

import (
	"log"
	"net/http/httptest"
	"strings"

	"github.com/labstack/echo/v4"
	"example.com/league/internal/fleet"

	"example.com/league/internal/standings"
	"example.com/garage/cars"
)

func ListClubs() []string {
	log.Printf("listing")
	car := cars.NewCar("AB-12")
	_ = car
	return standings.Table()
}

func ParkAll() {
	for _, v := range Fleet {
		v.Park()
		v.Header("plate")
	}
}

func Respond(c echo.Context) {
	c.Response().Header().Set("Cache-Control", "no-store")
	rec := httptest.NewRecorder()
	rec.Header()
	resp := (*c).Response()
	resp.Header()
	vans := fleet.Vans(Fleet)
	vans.Inspect()
}

func Kickoff(x interface{ Whistle() }) {
	x.Whistle()
}

func Trim(name string) string {
	before, _, _ := strings.Cut(name, " ")
	return before
}
`,
};

describe("Go package imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-go-packages-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("records the go.mod module beside the package.json name, and the replaced directory", () => {
    const root = summary.subProjects?.find((p) => p.root === "");
    expect(root?.packageName).toBe("league-web");
    expect(root?.packages).toEqual([
      { name: "example.com/league", ecosystem: "go" },
      { name: "example.com/garage", ecosystem: "go", root: "garage" },
    ]);
  });

  it("resolves a package call to the directory the module path names, though another is named alike", () => {
    expect(linkOf("ListClubs", "standings.Table")).toBe("internal/standings/table.go Table import-dir");
  });

  it("resolves an import a replace directive maps to a local directory", () => {
    expect(linkOf("ListClubs", "cars.NewCar")).toBe("garage/cars/car.go NewCar import-dir");
  });

  it("never takes a standard-library package for a project directory of the same name", () => {
    expect(linkOf("ListClubs", "log.Printf")).toBeNull();
  });

  it("links a method by its unique name when the caller's package imports its package", () => {
    expect(linkOf("ParkAll", "v.Park")).toBe("internal/fleet/van.go Van.Park unique-global");
  });

  it("never takes a value another module made for a project value of a method's name (real-repo FP)", () => {
    expect(linkOf("ParkAll", "v.Header")).toBe("internal/fleet/van.go Van.Header unique-global");
    expect(linkOf("Respond", "c.Response().Header")).toBeNull();
    expect(linkOf("Respond", "rec.Header")).toBeNull();
    expect(linkOf("Respond", "resp.Header")).toBeNull();
    // A conversion to a project type is a project value.
    expect(linkOf("Respond", "vans.Inspect")).toBe("internal/fleet/van.go Vans.Inspect unique-global");
  });

  it("leaves a method of a package the caller's package never imports unlinked", () => {
    expect(linkOf("Kickoff", "x.Whistle")).toBeNull();
  });

  it("never takes a call on a standard-library package for a project method of that name", () => {
    expect(linkOf("Trim", "strings.Cut")).toBeNull();
  });

  it("draws the import edge to the package the module path names only", () => {
    const edges = summary.componentGraph["internal/api/clubs.go"] ?? [];
    expect(edges).toContain("internal/standings/table.go");
    expect(edges).toContain("garage/cars/car.go");
    expect(edges).not.toContain("tools/standings/table.go");
    expect(edges).not.toContain("internal/log/log.go");
  });
});
