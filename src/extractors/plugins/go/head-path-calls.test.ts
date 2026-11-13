import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import "../../registry.js";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";
import { readGo } from "./antlr.js";

/**
 * A call through fields of a value the function declares — a range variable, a local typed by its initializer — is
 * named by its whole path from that head (`c.Status.String`), so the linker types the head and follows the fields;
 * a path whose head is a field or a package value names no class, whatever class of that name the project declares.
 * Each decoy is a namesake type the name guess would take: `api/status.go` and `api/league.go` sit beside the caller,
 * `other/controller.go` is the only `Controller`, and a `B` declares `Go` where an untyped path ends.
 */
const FILES: Record<string, string> = {
  "go.mod": "module example.com/league\n\ngo 1.22\n",
  "club/club.go": `package club

type Status struct{}

func (s *Status) String() string { return "" }

type League struct{}

func (l *League) Close() error { return nil }

type Club struct {
\tStatus Status
\tLeague *League
}

type Manager struct{}

func (m *Manager) Club() *Club { return &Club{} }
`,
  "api/status.go": `package api

type Status struct{}

func (s *Status) String() string { return "decoy" }
`,
  "api/league.go": `package api

type League struct{}

func (l *League) Close() error { return nil }

type B struct{}

func (b *B) Go() {}
`,
  "other/controller.go": `package other

type Controller struct{}

func (c *Controller) Delete(id string) error { return nil }
`,
  "api/run.go": `package api

import "example.com/league/club"

func RangeLocal(clubs []*club.Club) {
\tfor _, c := range clubs {
\t\t_ = c.Status.String()
\t}
}

func InitializerLocal(m *club.Manager) {
\tx := m.Club()
\tx.League.Close()
}

func UntypedPath(q Weird) {
\tz := q.Make()
\tz.A.B.Go()
}
`,
  "api/server.go": `package api

import "example.com/league/club"

type Server struct {
\tController club.Removable
}

func (s *Server) Drop(id string) {
\ts.Controller.Delete(id)
}

var global Holder

func DropGlobal(id string) {
\tglobal.Controller.Delete(id)
}
`,
};

describe("a Go call named from a local's head", () => {
  it("is the whole path for a range variable and an initialized local; a path from a package value keeps two names, cut", () => {
    const parsed = readGo(`package api

func Run(clubs []Club, m *Manager) {
\tfor _, c := range clubs {
\t\tc.Status.Rank()
\t}
\tx := m.Club()
\tx.League.Close()
\tglobal.Controller.Delete(1)
}
`);
    const calls = parsed.functions[0]!.calls.filter((c) => !c.passed);
    expect(calls.map((c) => c.name)).toEqual(["c.Status.Rank", "m.Club", "x.League.Close", "Controller.Delete"]);
    expect(calls.filter((c) => c.receiverCut).map((c) => c.name)).toEqual(["Controller.Delete"]);
  });
});

describe.each([["ANTLR", undefined], ["regex", "no-antlr"]])("Go calls through a local's fields (%s front end)", (_name, features) => {
  let dir = "";
  let summary: ProjectAnalysis;
  let saved: string | undefined;
  beforeAll(async () => {
    saved = process.env.CLARIFYDOC_FEATURES;
    if (features) process.env.CLARIFYDOC_FEATURES = features;
    else delete process.env.CLARIFYDOC_FEATURES;
    dir = await mkdtemp(join(tmpdir(), "cd-go-head-path-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    if (saved === undefined) delete process.env.CLARIFYDOC_FEATURES;
    else process.env.CLARIFYDOC_FEATURES = saved;
    await rm(dir, { recursive: true, force: true });
  });

  const targets = (from: string) =>
    (summary.symbolLinks ?? [])
      .filter((l) => l.sourceSymbol === from || l.sourceSymbol.endsWith(`.${from}`))
      .map((l) => `${l.callName} -> ${l.targetFile}::${l.targetSymbol}`)
      .sort();

  it("types a range variable and an initialized local, then follows the fields — never the namesake beside the caller", () => {
    expect(targets("RangeLocal")).toEqual(["c.Status.String -> club/club.go::Status.String"]);
    expect(targets("InitializerLocal")).toContain("x.League.Close -> club/club.go::League.Close");
    expect(targets("InitializerLocal").filter((t) => t.startsWith("x.League"))).toHaveLength(1);
  });

  it("falls back to the path's two-name reading when nothing types the local's head (real-repo FP: `input.ColorOrder.Valid` off `input := m.meta.Input`)", () => {
    // The two names guess the field's type by its name, as before paths were named from locals: the whole path names
    // nothing here, so `B.Go` is the fallback (`CallInfo.fallbackName`), the link still named as written.
    expect(targets("UntypedPath").filter((t) => t.includes("Go"))).toEqual(["z.A.B.Go -> api/league.go::B.Go"]);
  });

  it("gives a field or package value's method to no namesake class", () => {
    expect(targets("Drop")).toEqual([]);
    expect(targets("DropGlobal")).toEqual([]);
  });
});
