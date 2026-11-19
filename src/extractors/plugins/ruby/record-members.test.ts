import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { rubySpec } from "./index.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const classesOf = (src: string) => rubySpec.extractClasses!(src.split("\n"), []);

describe("Ruby: classes a constant names through Struct.new and Data.define", () => {
  it("makes a class of the constant, with the fields as members and the block's defs as methods", () => {
    const [score, transfer] = classesOf([
      "Score = Struct.new(:home, :away) do",
      "  def total",
      "    home + away",
      "  end",
      "end",
      "",
      "Transfer = Data.define(:player, :fee) do",
      "  def describe = player",
      "end",
    ].join("\n"));
    expect(score!.name).toBe("Score");
    expect(score!.methods.map((m) => m.name).sort()).toEqual(["away", "away=", "home", "home=", "total"]);
    expect(transfer!.name).toBe("Transfer");
    // A Data member is read-only.
    expect(transfer!.methods.map((m) => m.name).sort()).toEqual(["describe", "fee", "player"]);
  });

  it("gives a class that includes Singleton a class-level `instance`", () => {
    const [registry] = classesOf("class Registry\n  include Singleton\n\n  def register(name)\n    name\n  end\nend\n");
    expect(registry!.methods.find((m) => m.name === "instance")).toMatchObject({ classLevel: true, synthetic: true });
  });

  it("reads the class a Sorbet sig returns", () => {
    const [lookup] = classesOf([
      "class Lookup",
      "  sig { returns(Score) }",
      "  def score",
      "  end",
      "",
      "  sig { returns(T.nilable(Transfer)) }",
      "  def transfer",
      "  end",
      "",
      "  sig { void }",
      "  def reset",
      "  end",
      "",
      "  sig { returns(T::Array[Score]) }",
      "  def all",
      "  end",
      "end",
    ].join("\n"));
    expect(lookup!.methods.map((m) => [m.name, m.returnType])).toEqual([["score", "Score"], ["transfer", "Transfer | nil"], ["reset", null], ["all", null]]);
  });
});

describe("calls on members a macro declares, and an ivar typed through its owner's association", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-records-"));
    const files: Record<string, string> = {
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\nend\n",
      "app/models/league.rb": "class League < ApplicationRecord\n  has_many :clubs\nend\n",
      "app/models/club.rb": "class Club < ApplicationRecord\nend\n",
      "app/models/garage.rb": 'class Garage < ApplicationRecord\n  has_many :clubs, class_name: "Depot"\nend\n',
      "app/models/depot.rb": "class Depot < ApplicationRecord\nend\n",
      "app/controllers/clubs_controller.rb": [
        "class ClubsController < ApplicationController",
        "  def show",
        "    @league = League.find(params[:league_id])",
        "    @team = @league.clubs.find_by(id: params[:id])",
        '    @team.update!(name: "x")', // 5
        "  end",
        "end",
        "",
      ].join("\n"),
      // The decoy: the same association name on another model, and an owner nothing types.
      "app/controllers/depots_controller.rb": [
        "# Depots, which belong to garages.",
        "#",
        "class DepotsController < ApplicationController",
        "  def show",
        "    @garage = Garage.find(params[:garage_id])",
        "    @team = @garage.clubs.find_by(id: params[:id])",
        '    @team.update!(name: "y")', // 7
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/controllers/mystery_controller.rb": [
        "class MysteryController < ApplicationController",
        "  def show",
        "    @team = @mystery.clubs.find_by(id: params[:id])",
        '    @team.update!(name: "z")', // 4
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/services/macros.rb": [
        "Score = Struct.new(:home, :away) do",
        "  def total",
        "    home + away",
        "  end",
        "end",
        "",
        "class Registry",
        "  include Singleton",
        "",
        "  def register(name)",
        "    name",
        "  end",
        "end",
        "",
        "class Lookup",
        "  sig { returns(Score) }",
        "  def score",
        "    Score.new(1, 2)",
        "  end",
        "end",
        "",
        "class Report",
        "  def run",
        "    s = Score.new(1, 2)",
        "    s.total", // 25
        '    Registry.instance.register("x")', // 26
        "    lk = Lookup.new",
        "    lk.score.total", // 28
        "  end",
        "end",
        "",
      ].join("\n"),
      // The decoy: a class whose methods carry the same names.
      "app/services/ledger.rb": "class Ledger\n  def total\n    1\n  end\n\n  def register(name)\n    name\n  end\nend\n\nclass Other\n  def go(ledger)\n    ledger.total\n  end\nend\n",
    };
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const calls = () => (summary.dataAccessGraph?.edges ?? []).flatMap((e) => e.calls);
  const target = (line: number, name: string) =>
    (summary.symbolLinks ?? []).filter((l) => l.sourceFile === "app/services/macros.rb" && l.sourceLine === line && l.callName.startsWith(name)).map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("types an ivar by the association of the model its owner variable holds", () => {
    expect(calls().filter((c) => c.name === "@team.update!" && c.line === 5).map((c) => c.entity)).toEqual(["Club"]);
    expect(calls().filter((c) => c.name === "@team.update!" && c.line === 7).map((c) => c.entity)).toEqual(["Depot"]);
  });

  it("types nothing from an owner nothing types", () => {
    expect(calls().filter((c) => c.name === "@team.update!" && c.line === 4).map((c) => c.entity)).not.toContain("Depot");
  });

  it("links a call on a Struct member, `Registry.instance` and a sig-typed result to their definitions", () => {
    expect(target(25, "s.total")).toEqual(["app/services/macros.rb::Score.total"]);
    // The accessor, and the method called on what it returns.
    expect(target(26, "Registry.instance")).toEqual(["app/services/macros.rb::Registry.instance", "app/services/macros.rb::Registry.register"]);
    expect(target(28, "lk.score.total")).toEqual(["app/services/macros.rb::Score.total"]);
  });
});
