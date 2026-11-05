import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { goCollection, collectionBuilt } from "./element-types.js";

describe("goCollection", () => {
  it("reads the element of a slice, array, map and channel type", () => {
    expect(goCollection("[]Club")).toEqual({ kind: "slice", key: null, value: "Club" });
    expect(goCollection("[]*Club")).toEqual({ kind: "slice", key: null, value: "*Club" });
    expect(goCollection("[3]model.Club")).toEqual({ kind: "slice", key: null, value: "model.Club" });
    expect(goCollection("map[string]*Club")).toEqual({ kind: "map", key: "string", value: "*Club" });
    expect(goCollection("map[Key[int]]Club")?.value).toBe("Club");
    expect(goCollection("<-chan *Club")).toEqual({ kind: "chan", key: null, value: "*Club" });
    expect(goCollection("[]string")).toBeNull();
    expect(goCollection("Club")).toBeNull();
  });
  it("names the collection a literal or make builds", () => {
    expect(collectionBuilt("[]Club{}")).toBe("[]Club");
    expect(collectionBuilt("make(map[string]*Club)")).toBe("map[string]*Club");
    expect(collectionBuilt("make(chan *Club, 4)")).toBe("chan *Club");
    expect(collectionBuilt("&Club{}")).toBeNull();
  });
});

const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\ngo 1.21\n",
  "club.go": `package main

type Club struct{ Name string }

func (c *Club) Promote() {}

type Player struct{ Name string }

func (p *Player) Promote() {}
`,
  "use.go": `package main

type League struct {
	clubs  []Club
	byName map[string]*Club
}

var registry = map[string]*Club{}
var squad []Club
var first = &Club{}

func newClubs() []*Club { return nil }

func (l *League) FromField() {
	for _, c := range l.clubs {
		c.Promote()
	}
}
func (l *League) FromMap() {
	for _, c := range l.byName {
		c.Promote()
	}
}
func FromLocal() {
	cs := []Club{}
	for _, c := range cs {
		c.Promote()
	}
}
func FromCall() {
	cs := newClubs()
	for _, c := range cs {
		c.Promote()
	}
}
func FromPkgVar() {
	for _, c := range squad {
		c.Promote()
	}
	for _, c := range registry {
		c.Promote()
	}
}
func FromVarDecl() {
	var cs []*Club
	for _, c := range cs {
		c.Promote()
	}
}
func TypeSwitch(x interface{}) {
	switch v := x.(type) {
	case *Club:
		v.Promote()
	}
}
func Assert(x interface{}) {
	c := x.(*Club)
	c.Promote()
	d, ok := x.(*Club)
	if ok {
		d.Promote()
	}
}
func MapIndex(m map[string]*Club) {
	m["a"].Promote()
	c := m["b"]
	c.Promote()
	if e, ok := m["c"]; ok {
		e.Promote()
	}
}
func SliceIndex(s []Club) {
	s[0].Promote()
	c := s[1]
	c.Promote()
}
func Chan(ch chan *Club) {
	c := <-ch
	c.Promote()
}
func Lit() {
	(&Club{}).Promote()
	Club{}.Promote()
}
func PkgVarCall() {
	first.Promote()
	registry["x"].Promote()
}


func Mixed(a []Club, b []Player) {
	for _, z := range a {
		z.Promote()
	}
	for _, z := range b {
		z.Promote()
	}
}

func Decoy(players []Player, byTeam map[string]*Player, x interface{}) {
	for _, p := range players {
		p.Promote()
	}
	q := byTeam["a"]
	q.Promote()
	switch v := x.(type) {
	case *Player:
		v.Promote()
	case *Club, *Player:
		v.Promote()
	default:
		v.Promote()
	}
}

func Plain(names []string) {
	for _, n := range names {
		n.Promote()
	}
}
`,
};

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Go element types and narrowing (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-go-elements-"));
    for (const [rel, text] of Object.entries(FILES)) await writeFile(join(dir, rel), text);
    await analyze({ projectRoot: dir, outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  });
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  /** `Type.method` targets of the calls named `callName` in function `from` (a method's symbol is `Owner.name`). */
  const target = (from: string, callName: string) =>
    summary.symbolLinks
      .filter((l) => (l.sourceSymbol === from || l.sourceSymbol.endsWith(`.${from}`)) && l.callName === callName)
      .map((l) => l.targetSymbol);

  it("types a range variable over a field, a map field, a local, a call, a package variable and a var declaration", () => {
    for (const fn of ["FromField", "FromMap", "FromLocal", "FromCall", "FromVarDecl"]) expect(target(fn, "c.Promote"), fn).toEqual(["Club.Promote"]);
    expect(target("FromPkgVar", "c.Promote")).toEqual(["Club.Promote"]);
  });

  it("types a type switch clause, a type assertion and an element access", () => {
    expect(target("TypeSwitch", "v.Promote")).toEqual(["Club.Promote"]);
    expect(target("Assert", "c.Promote")).toEqual(["Club.Promote"]);
    expect(target("Assert", "d.Promote")).toEqual(["Club.Promote"]);
    for (const n of ["c", "e"]) expect(target("MapIndex", `${n}.Promote`)).toEqual(["Club.Promote"]);
    expect(target("SliceIndex", "c.Promote")).toEqual(["Club.Promote"]);
    expect(target("Chan", "c.Promote")).toEqual(["Club.Promote"]);
  });

  it("links a call on an indexed receiver, a composite literal and a typed package variable", () => {
    expect(target("MapIndex", "m[].Promote")).toEqual(["Club.Promote"]);
    expect(target("SliceIndex", "s[].Promote")).toEqual(["Club.Promote"]);
    expect(target("Lit", "Club.Promote")).toEqual(["Club.Promote"]);
    expect(target("PkgVarCall", "first.Promote")).toEqual(["Club.Promote"]);
    expect(target("PkgVarCall", "registry[].Promote")).toEqual(["Club.Promote"]);
  });

  it("keeps the namesake apart and leaves ambiguous bindings untyped", () => {
    expect(target("Decoy", "p.Promote")).toEqual(["Player.Promote"]);
    expect(target("Decoy", "q.Promote")).toEqual(["Player.Promote"]);
    expect(target("Mixed", "z.Promote")).toEqual([]);
    expect(target("Plain", "n.Promote")).toEqual([]);
  });

  if (!features) {
    it("types a type switch variable per clause", () => {
      expect(target("Decoy", "v.Promote")).toEqual(["Player.Promote"]);
    });
  }
});
