import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function scan(files: Record<string, string[]>, dir: string): Promise<ProjectAnalysis> {
  const root = join(dir, "src");
  for (const [rel, lines] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), lines.join("\n") + "\n");
  }
  await analyze({ projectRoot: root, outputDir: join(dir, "out"), lsp: false, gitHistory: false, stableOutput: true });
  return loadReportSummary(join(dir, "out"));
}

const calls = (s: ProjectAnalysis, name: string) => s.symbolLinks.filter((l) => l.callName === name);

describe("a top-level Ruby constant bound to an instance types its receiver", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-ruby-constants-"));
    summary = await scan(
      {
        "app/club_service.rb": ["class ClubService", "  def process(club)", "    club", "  end", "end"],
        "app/garage_service.rb": ["class GarageService", "  def process(car)", "    car", "  end", "end"],
        "app/services.rb": [
          'require_relative "club_service"',
          'require_relative "garage_service"',
          "",
          "SERVICE = ClubService.new",
          "GARAGE = GarageService.new",
          "REPORT = Struct.new(:club)",
          "",
          "def run_all(club)",
          "  SERVICE.process(club)",
          "end",
        ],
        "app/main.rb": [
          'require_relative "services"',
          "",
          "def kickoff(club)",
          "  SERVICE.process(club)",
          "end",
          "",
          "class Runner",
          "  def go(car)",
          "    GARAGE.process(car)",
          "  end",
          "end",
        ],
        // A namesake constant in a file nothing requires, bound to the other class.
        "app/elsewhere.rb": ["require_relative 'garage_service'", "SERVICE = GarageService.new", "def other(car)", "  SERVICE.process(car)", "end"],
        // No require reaches the constant: nothing to link.
        "app/lonely.rb": ["def lonely(club)", "  SERVICE.process(club)", "end"],
      },
      dir,
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const hits = (file: string) => calls(summary, "SERVICE.process").concat(calls(summary, "GARAGE.process")).filter((l) => l.sourceFile.endsWith(file));

  it("links the constant's call in its own file and in a file that requires it", () => {
    expect(hits("app/services.rb").map((l) => `${l.targetFile}:${l.targetSymbol}`)).toEqual(["app/club_service.rb:ClubService.process"]);
    expect(hits("app/main.rb").map((l) => `${l.targetFile}:${l.targetSymbol}`).sort()).toEqual([
      "app/club_service.rb:ClubService.process",
      "app/garage_service.rb:GarageService.process",
    ]);
  });

  it("types a namesake constant by its own file's initializer", () => {
    expect(hits("app/elsewhere.rb").map((l) => l.targetFile)).toEqual(["app/garage_service.rb"]);
  });

  it("links nothing where no file in reach binds the constant", () => {
    expect(hits("app/lonely.rb")).toEqual([]);
  });
});

describe("a module alias picks the module a qualified type is written through", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "clarifydoc-module-alias-"));
    summary = await scan(
      {
        "scoring.py": ["class Table:", "    def rank(self):", "        return 1"],
        "standings.py": ["class Table:", "    def sort(self):", "        return 2"],
        "flat_alias.py": ["import scoring as sc", "import standings as st", "", "def flat():", "    a = sc.Table()", "    a.rank()", "    b = st.Table()", "    b.sort()"],
        "league/__init__.py": [""],
        "league/models.py": ["class Club:", "    def save(self):", "        return 1"],
        "garage/__init__.py": [""],
        "garage/models.py": ["class Club:", "    def save(self):", "        return 2"],
        "dotted_alias.py": ["import league.models as m", "", "def dotted():", "    u = m.Club()", "    u.save()"],
        "from_alias.py": ["from league import models as lm", "", "def aliased():", "    u = lm.Club()", "    u.save()"],
        "from_plain.py": ["from garage import models", "", "def plain():", "    u = models.Club()", "    u.save()"],
        "dotted_plain.py": ["import garage.models", "", "def whole():", "    u = garage.models.Club()", "    u.save()"],
        // The qualifier names no import: the namesakes stay ambiguous and nothing is linked.
        "unbound.py": ["def unbound(m):", "    u = m.Club()", "    u.save()"],
      },
      dir,
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const save = (file: string) => calls(summary, "u.save").filter((l) => l.sourceFile === file).map((l) => l.targetFile);

  it("types the local by the module the import names", () => {
    expect(save("dotted_alias.py")).toEqual(["league/models.py"]);
    expect(save("from_alias.py")).toEqual(["league/models.py"]);
    expect(save("from_plain.py")).toEqual(["garage/models.py"]);
    expect(save("dotted_plain.py")).toEqual(["garage/models.py"]);
  });

  it("tells two same-named classes of flat modules apart by the alias", () => {
    const flat = summary.symbolLinks.filter((l) => l.sourceFile === "flat_alias.py" && /^[ab]\./.test(l.callName));
    expect(flat.map((l) => `${l.callName}->${l.targetFile}`).sort()).toEqual(["a.rank->scoring.py", "b.sort->standings.py"]);
  });

  it("links nothing through a qualifier no import binds", () => {
    expect(save("unbound.py")).toEqual([]);
  });
});
