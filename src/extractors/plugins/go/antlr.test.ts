import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { readGo } from "./antlr.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import "../../registry.js";

const LEAGUE = `package league

import (
	"encoding/json"
	"net/http"

	"github.com/urfave/cli/v3"
	yaml "gopkg.in/yaml.v3"
	pb "example.com/league/gen"
)

// FixtureSQL is a template, not code: kickoff() inside it is no call.
const FixtureSQL = \`
SELECT kickoff(id) FROM fixtures
\`

func NewCommand() *cli.Command {
	return &cli.Command{Name: "league"}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var club Club
	if err := json.NewDecoder(r.Body).Decode(&club); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	go func() {
		h.repo.Save(club)
	}()
	h.squad[0].Substitute()
	match := new(h.repo.LoadMatch(club.ID))
	reply, _ := pb.NewLeagueClient(h.conn).GetMatch(r.Context(), match)
	yaml.Marshal(reply)
	type scout interface{ Watch() error }
}

func External() int
`;

describe("Go through ANTLR", () => {
  it("reads every top-level func with its exact span; a function literal is part of its holder", () => {
    const parsed = readGo(LEAGUE);
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions.map((f) => [f.name, f.line, f.endLine])).toEqual([
      ["NewCommand", 17, 19],
      ["ServeHTTP", 21, 35],
      ["External", 37, 37],
    ]);
  });

  it("names calls as the regex scan does, and records none in a raw string or an interface method", () => {
    const serve = readGo(LEAGUE).functions.find((f) => f.name === "ServeHTTP")!;
    expect(serve.calls.map((c) => c.name)).toEqual([
      "json.NewDecoder().Decode",
      "json.NewDecoder",
      "http.Error",
      "err.Error",
      "repo.Save",
      "repo.LoadMatch",
      "pb.NewLeagueClient().GetMatch",
      "pb.NewLeagueClient",
      "r.Context",
      "yaml.Marshal",
    ]);
  });

  it("parses what the upstream grammar refuses in real code (real-repo FP)", () => {
    // `new(expr)`, a selector on a value in `new`, a parenthesized conversion type, a generic method.
    expect(readGo("package p\n\nfunc f() { _ = new(load(1)); _ = new(int); _ = make([]int, 3); _ = new(match.Referee.Name) }\n").syntaxErrors).toBe(0);
    expect(readGo('package p\n\nfunc f() { _ = new([]string{"home", "away"}); _ = new(-2); _ = new(squad[0].ID); _ = new(map[string]int) }\n').syntaxErrors).toBe(0);
    expect(readGo("package p\n\nfunc f() { _ = ([]*squad.Player)(nil) }\n").syntaxErrors).toBe(0);
    expect(readGo("package p\n\nfunc (c *Coach) Report[T string | int](v T) { c.write(v) }\n").functions.map((f) => f.name)).toEqual(["Report"]);
    // A composite literal of a package whose name is not its path's last element: no import table decides it.
    expect(readGo(`package p\n\nimport (\n\t"github.com/urfave/cli/v3"\n\t"example.com/go-league-client"\n)\n\nfunc f() { _ = &cli.Command{}; _ = league.Fixture{} }\n`).syntaxErrors).toBe(0);
    // A statement list's last terminator left out before `}`, and a composite literal in an `if` needing parentheses.
    expect(readGo("package p\n\nfunc f() { if x.Ready { kickoff() }; for _, c := range (squad.Lineup{}) { c.Warm() } }\n").syntaxErrors).toBe(0);
  });

  it("reads `*T(x)` as a dereferenced call, as the Go spec does (real-repo FP)", () => {
    const parsed = readGo("package p\n\nfunc f() {\n\t_ = Squad{Captain: *NewPlayer(9)}\n\t_ = (*Coach)(nil)\n}\n");
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions[0]!.calls.map((c) => c.name)).toEqual(["NewPlayer"]);
  });

  it("names a generic function called through its package", () => {
    const parsed = readGo("package p\n\nfunc f() {\n\tc, _ := lru.New[string, *Club](32)\n\tc.Add(\"x\", nil)\n}\n");
    expect(parsed.syntaxErrors).toBe(0);
    expect(parsed.functions[0]!.calls.map((c) => c.name)).toEqual(["lru.New", "c.Add"]);
  });

  it("keeps a method named like another language's keyword, and records no conversion or keyword as a call (real-repo FP)", () => {
    const parsed = readGo("package p\n\nfunc (g *Garage) do(car Car) error {\n\tvar (\n\t\tn = 1\n\t)\n\tgo func() { g.wash(car) }()\n\t_ = []byte(car.Plate)\n\treturn nil\n}\n");
    expect(parsed.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["do", ["g.wash"]]]);
  });

  it("counts the syntax errors of a file the grammar cannot read, so core keeps the regex reading", () => {
    expect(readGo("package p\n\nfunc f( {\n").syntaxErrors).toBeGreaterThan(0);
  });
});

/**
 * Where the two readings of a fixture differ, and why the parser's is the one to keep: `file → function →
 * [calls only the patterns record, calls only the parser records]`.
 */
const KNOWN: Record<string, Record<string, [string[], string[]]>> = {
  // A chain wrapped over lines: the patterns read only the line `Scan(` is on, and record the bare leaf —
  // or nothing, when a raw string sits in the arguments.
  "test-fixtures/sample-go-gin/store/part_store.go": {
    GetPart: [["Scan"], ["db.QueryRowContext().Scan"]],
    CreatePart: [[], ["db.QueryRowContext().Scan"]],
  },
};

describe("Go: ANTLR and the patterns agree on the fixtures", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/**/*.go", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} as the patterns do, but where it is listed as better`, () => {
      const src = readFileSync(resolve(root, rel), "utf-8");
      const parsed = readGo(src);
      expect(parsed.syntaxErrors).toBe(0);
      const shape = (a: ReturnType<typeof extractWithRegex>) => [
        ...a.functions.map((f) => ({ name: f.name, line: f.line, endLine: f.endLine, calls: f.calls.map((c) => c.name) })),
        ...a.classes.flatMap((c) => c.methods.map((m) => ({ name: `${c.name}.${m.name}`, line: m.line, endLine: m.endLine, calls: m.calls.map((x) => x.name) }))),
      ];
      const regex = shape(extractWithRegex(src, rel, "go"));
      const antlr = shape(extractWithRegex(src, rel, "go", undefined, parsed));
      expect(antlr.map(({ calls: _, ...span }) => span)).toEqual(regex.map(({ calls: _, ...span }) => span));
      const differences: Record<string, [string[], string[]]> = {};
      regex.forEach((fn, i) => {
        const b = antlr[i]!.calls;
        const onlyA = fn.calls.filter((c) => !b.includes(c));
        const onlyB = b.filter((c) => !fn.calls.includes(c));
        if (onlyA.length + onlyB.length > 0) differences[fn.name] = [onlyA, onlyB];
      });
      expect(differences).toEqual(KNOWN[rel] ?? {});
    });
  }
});
