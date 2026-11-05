import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function build(prefix: string, files: Record<string, string>): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

describe("Python receivers narrowed by the body", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "pyproject.toml": '[project]\nname = "league"\n',
    "league/__init__.py": "",
    "app_rules/__init__.py": "",
    "app_rules/rules.py": "def check(): ...\n",
    "league/club.py": `class Club:
    @property
    def name(self) -> str:
        return "club"

    @classmethod
    def build(cls):
        return cls.drill()

    @classmethod
    def drill(cls):
        return 1

    def save(self) -> None: ...

    def rank(self) -> int: ...

    def __enter__(self) -> Club:
        return self


class Car:
    @property
    def name(self) -> str:
        return "car"

    def save(self) -> None: ...

    def rank(self) -> int: ...


class LeagueError(Exception):
    def code(self) -> int: ...


class Garage:
    def __enter__(self) -> Car:
        return Car()

    def save(self) -> None: ...


class OtherError(Exception):
    def code(self) -> int: ...
`,
    "league/use.py": `import importlib
from league.club import Club, Car, Garage, LeagueError


def load() -> tuple[Club, Car]:
    return Club(), Car()


def read_name(c: Club):
    return c.name


def narrow(x):
    if isinstance(x, Club):
        x.rank()


def narrow_tuple(x):
    if isinstance(x, (Club, Car)):
        x.save()


def ctx():
    with Club() as c:
        c.save()


def ctx_other():
    with Garage() as g:
        g.save()


def caught():
    try:
        pass
    except LeagueError as e:
        e.code()


def unpack():
    a, b = load()
    a.rank()
    b.save()


def dyn():
    return importlib.import_module("app_rules.rules")


def dyn2():
    return __import__("app_rules.rules")
`,
  };
  beforeAll(async () => {
    ({ dir, summary } = await build("cd-py-narrow-", files));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  const target = (from: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}:${l.strategy}`);

  it("types cls inside a classmethod as its class", () => {
    expect(target("Club.build", "cls.drill")).toEqual(["Club.drill:direct"]);
  });
  it("narrows on isinstance inside the branch", () => {
    expect(target("narrow", "x.rank")).toEqual(["Club.rank:injection"]);
    expect(target("narrow_tuple", "x.save")).toEqual([]);
  });
  it("types a with-as target by what the manager's __enter__ returns", () => {
    expect(target("ctx", "c.save")).toEqual(["Club.save:injection"]);
    expect(target("ctx_other", "g.save")).toEqual(["Car.save:injection"]);
  });
  it("types an except-as variable by the caught class", () => {
    expect(target("caught", "e.code")).toEqual(["LeagueError.code:injection"]);
  });
  it("types tuple unpacking from an annotated return", () => {
    expect(target("unpack", "a.rank")).toEqual(["Club.rank:injection"]);
    expect(target("unpack", "b.save")).toEqual(["Car.save:injection"]);
  });
  it("reads importlib.import_module and __import__ with a literal name as dynamic imports", () => {
    expect(summary.componentGraph["league/use.py"]).toContain("app_rules/rules.py");
  });
});
