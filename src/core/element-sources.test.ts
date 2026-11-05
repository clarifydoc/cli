import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * A loop variable, a callback parameter or a tuple target whose collection comes from a field or from a call's
 * DECLARED result — not from a parameter or local the body types. Each language has a namesake class (`Car`) with
 * the same method name that no link may reach.
 */
async function summaryOf(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-element-sources-"));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const targets = (summary: ProjectAnalysis, from: string, callName: string): string[] =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => l.targetSymbol);

function suite(name: string, files: Record<string, string>, check: (t: (from: string, call: string) => string[]) => void): void {
  describe(name, () => {
    let summary: ProjectAnalysis;
    let cleanup = async () => {};
    beforeAll(async () => ({ summary, cleanup } = await summaryOf(files)), 120000);
    afterAll(async () => cleanup());
    it("types the element from a declared field or result", () => check((from, call) => targets(summary, from, call)));
  });
}

suite("TypeScript", {
  "package.json": '{"name":"league","version":"1.0.0"}',
  "src/club.ts": `export class Club { save(): void {} }
export class Car { save(): void {} }
export class Repo { all(): Club[] { return []; } }
export function first<T>(items: T[]): T { return items[0]; }
`,
  "src/service.ts": `import { Club, Repo, first } from "./club";
export class Service {
  clubs: Club[] = [];
  private repo: Repo = new Repo();
  field() { this.clubs.forEach((c) => c.save()); }
  loop() { for (const c of this.clubs) { c.save(); } }
  result() { for (const m of this.repo.all()) { m.save(); } }
  callback() { this.repo.all().forEach((k) => k.save()); }
  generic(cs: Club[]) { first(cs).save(); }
}
`,
}, (t) => {
  expect(t("Service.field", "c.save")).toEqual(["Club.save"]);
  expect(t("Service.loop", "c.save")).toEqual(["Club.save"]);
  expect(t("Service.result", "m.save")).toEqual(["Club.save"]);
  expect(t("Service.callback", "k.save")).toEqual(["Club.save"]);
  expect(t("Service.generic", "first(cs).save")).toEqual(["Club.save"]);
});

suite("Python", {
  "pyproject.toml": '[project]\nname = "league"\n',
  "league/club.py": `class Club:
    def save(self) -> None: ...


class Car:
    def save(self) -> None: ...


class League:
    def close(self) -> None: ...


class Repo:
    def load(self) -> list[Club]: ...

    def pair(self) -> tuple[Club, League]: ...
`,
  "league/service.py": `from league.club import Car, Club, League, Repo


class Service:
    def __init__(self):
        self.items: list[Club] = []
        self.repo = Repo()

    def field(self):
        for c in self.items:
            c.save()

    def result(self):
        for m in self.repo.load():
            m.save()

    def comprehension(self):
        return [k.save() for k in self.repo.load()]

    def unpack(self):
        club, league = self.repo.pair()
        league.close()

    def narrow_one(self, x):
        if isinstance(x, (Club, League)):
            x.close()

    def narrow_both(self, x):
        if isinstance(x, (Club, Car)):
            x.save()
`,
}, (t) => {
  expect(t("Service.field", "c.save")).toEqual(["Club.save"]);
  expect(t("Service.result", "m.save")).toEqual(["Club.save"]);
  expect(t("Service.comprehension", "k.save")).toEqual(["Club.save"]);
  expect(t("Service.unpack", "league.close")).toEqual(["League.close"]);
  // Only League declares `close`: the tuple narrows to it. Both Club and Car declare `save`: refused.
  expect(t("Service.narrow_one", "x.close")).toEqual(["League.close"]);
  expect(t("Service.narrow_both", "x.save")).toEqual([]);
});

suite("C#", {
  "A.cs": `using System.Collections.Generic;
using System.Threading.Tasks;
class Club { public void Save() {} }
class Car { public void Save() {} }
class Repo {
  public Task<List<Club>> AllAsync() => null;
  public List<Club> All() => null;
}
class Service {
  Repo repo;
  List<Club> clubs;
  async Task Awaited() { foreach (var c in await repo.AllAsync()) { c.Save(); } }
  void Plain() { foreach (var m in repo.All()) { m.Save(); } }
}
`,
}, (t) => {
  expect(t("Service.Awaited", "c.Save")).toEqual(["Club.Save"]);
  expect(t("Service.Plain", "m.Save")).toEqual(["Club.Save"]);
});

suite("Java", {
  "A.java": `import java.util.List;
class Club { void save() {} }
class Car { void save() {} }
class Repo { List<Club> all() { return null; } }
class Service {
  Repo repo;
  void loop() { for (var c : repo.all()) c.save(); }
  void callback() { repo.all().forEach(k -> k.save()); }
}
`,
}, (t) => {
  expect(t("Service.loop", "c.save")).toEqual(["Club.save"]);
  expect(t("Service.callback", "k.save")).toEqual(["Club.save"]);
});

suite("Go", {
  "go.mod": "module league\n\ngo 1.21\n",
  "club.go": `package league

type Club struct{}

func (c *Club) Save() {}

type Car struct{}

func (c *Car) Save() {}
`,
  "repo.go": `package league

type Repo struct {
	Clubs []*Club
}

var All []*Club

func Load() []*Club { return nil }
`,
  "run.go": `package league

func fromField(r *Repo) {
	for _, c := range r.Clubs {
		c.Save()
	}
}

func fromVar() {
	for _, v := range All {
		v.Save()
	}
}

func fromResult() {
	for _, m := range Load() {
		m.Save()
	}
}
`,
}, (t) => {
  expect(t("fromField", "c.Save")).toEqual(["Club.Save"]);
  expect(t("fromVar", "v.Save")).toEqual(["Club.Save"]);
  expect(t("fromResult", "m.Save")).toEqual(["Club.Save"]);
});
