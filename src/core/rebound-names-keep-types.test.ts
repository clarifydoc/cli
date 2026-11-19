import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

async function build(prefix: string, files: Record<string, string>): Promise<{ dir: string; summary: ProjectAnalysis }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { dir, summary: await loadReportSummary(join(dir, "out")) };
}

const targets = (s: ProjectAnalysis, from: string, callName: string): string[] =>
  s.symbolLinks.filter((l) => l.sourceSymbol === from && l.callName === callName).map((l) => `${l.targetSymbol}`);

describe("a rebound name does not keep its documented or module type", () => {
  let dir = "";
  let summary: ProjectAnalysis;
  const files: Record<string, string> = {
    "app.php": `<?php
class Car { public function save() {} }
class Club { public function save() {} }
class Garage {
  private function pick() { return mystery(); }
  /** @param Car $x */
  function rebound($x) { $x = $this->pick(); $x->save(); }
  /** @param Car $y */
  function kept($y) { $y->save(); }
  /** @param Car $z */
  function built($z) { $z = new Club(); $z->save(); }
}
`,
    "app.rb": `class Car
  def save; end
end
class Club
  def save; end
end
class Depot
  # @param x [Car]
  def rebound(x)
    x = Club.new
    x.save
  end
  # @param y [Car]
  def kept(y)
    y.save
  end
  # @param z [Car]
  def refreshed(z)
    z = z.reload
    z.save
  end
end
`,
    "match.py": `class Match:
    def play(self): ...


class Friendly:
    def play(self): ...


current = Match()
steady = Match()


def switch():
    global current
    current = Friendly()


def kickoff():
    current.play()


def hold():
    steady.play()


def peek():
    global steady
    print(steady)
`,
  };
  beforeAll(async () => {
    ({ dir, summary } = await build("cd-rebound-", files));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("PHP: a documented formal the body assigns links nothing the docblock says", () => {
    expect(targets(summary, "Garage.rebound", "x.save")).toEqual([]);
  });
  it("PHP: an unrebound documented formal still links, and a construction wins", () => {
    expect(targets(summary, "Garage.kept", "y.save")).toEqual(["Car.save"]);
    expect(targets(summary, "Garage.built", "z.save")).toEqual(["Club.save"]);
  });
  it("Ruby: a documented formal the body reassigns takes the local's type", () => {
    expect(targets(summary, "Depot.rebound", "x.save")).toEqual(["Club.save"]);
    expect(targets(summary, "Depot.kept", "y.save")).toEqual(["Car.save"]);
    expect(targets(summary, "Depot.refreshed", "z.save")).toEqual(["Car.save"]);
  });
  it("Python: a module variable a function rebinds through global is not typed by its first initializer", () => {
    expect(targets(summary, "kickoff", "current.play")).toEqual([]);
    expect(targets(summary, "hold", "steady.play")).toEqual(["Match.play"]);
  });
});
