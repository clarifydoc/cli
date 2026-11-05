import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** A Rails concern's class methods: `class_methods do`, or a `ClassMethods` module its includers are extended with (real-repo FP). */
const FILES: Record<string, string> = {
  Gemfile: 'gem "rails"\ngem "rspec-rails"\n',
  "app/models/concerns/standings.rb": `module Standings
  extend ActiveSupport::Concern

  included do
    before_save :recount
  end

  class_methods do
    def sort_on_points(direction = :desc)
      order(points: direction).merge(tie_breaker)
    end

    private

    def tie_breaker
      order(:id)
    end
  end

  def recount
    1
  end
end
`,
  "app/models/concerns/rankings.rb": `module Rankings
  def self.included(base)
    base.extend(ClassMethods)
  end

  module ClassMethods
    def top_ranked
      limit(3)
    end
  end

  def rank
    2
  end
end
`,
  "app/models/concerns/decoy_sorting.rb": `module DecoySorting
  def sort_on_points
    0
  end

  def self.top_ranked
    0
  end
end
`,
  "app/models/club.rb": `class Club < ApplicationRecord
  include Standings
  include Rankings

  def self.table
    sort_on_points
  end

  def promote
    sort_on_points
  end
end
`,
  "app/services/table_service.rb": `class TableService
  def build
    Club.sort_on_points(:asc)
    Club.top_ranked
    Standings.sort_on_points
  end
end
`,
  "lib/league/slugs.rb": `module League
  module Slugs
    extend self

    def slug(name)
      clean(name)
    end

    def clean(name)
      name
    end
  end
end
`,
  "lib/league/pads.rb": `module League::Pads
  def pad(text)
    text
  end
  module_function :pad

  def self.trim(text)
    pad(text)
  end
end
`,
  "app/services/fixture_service.rb": `class FixtureService
  def label(club)
    League::Slugs.slug(club)
    League::Pads.pad(club)
  end
end
`,
  "spec/models/club_spec.rb": `require 'rails_helper'

RSpec.describe Club do
  it 'sorts on points' do
    expect(described_class.sort_on_points).to eq([])
  end
end
`,
};

describe("Rails concerns: class methods reach the classes that include them", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-concerns-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linksOf = (symbol: string, callName: string) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("states a class_methods block as the concern's ClassMethods module, which its includers are extended with", () => {
    const { classes } = extractWithRegex(FILES["app/models/concerns/standings.rb"]!, "app/models/concerns/standings.rb", "ruby");
    const standings = classes.find((c) => c.name === "Standings")!;
    const classMethods = classes.find((c) => c.name === "ClassMethods")!;
    expect(standings.methods.map((m) => m.name)).toEqual(["recount"]);
    expect(classMethods.methods.map((m) => m.name)).toEqual(["sort_on_points", "tie_breaker"]);
    expect(standings.includerExtends).toEqual(["Standings::ClassMethods"]);
    const rankings = extractWithRegex(FILES["app/models/concerns/rankings.rb"]!, "app/models/concerns/rankings.rb", "ruby").classes;
    expect(rankings.find((c) => c.name === "Rankings")!.includerExtends).toEqual(["Rankings::ClassMethods"]);
  });

  it("reaches a concern's class method on the including class, never a decoy's", () => {
    expect(linksOf("TableService.build", "Club.sort_on_points")).toEqual(["app/models/concerns/standings.rb::ClassMethods.sort_on_points"]);
    expect(linksOf("TableService.build", "Club.top_ranked")).toEqual(["app/models/concerns/rankings.rb::ClassMethods.top_ranked"]);
    expect(linksOf("Club › sorts on points", "Club.sort_on_points")).toEqual(["app/models/concerns/standings.rb::ClassMethods.sort_on_points"]);
  });

  it("reaches it from a method of the class object, never from an instance", () => {
    expect(linksOf("Club.table", "sort_on_points")).toEqual(["app/models/concerns/standings.rb::ClassMethods.sort_on_points"]);
    expect(linksOf("Club.promote", "sort_on_points")).toEqual([]);
  });

  it("is no method of the concern module itself", () => {
    expect(linksOf("TableService.build", "Standings.sort_on_points")).toEqual([]);
  });

  it("keeps a class method's calls inside its module", () => {
    expect(linksOf("ClassMethods.sort_on_points", "tie_breaker")).toEqual(["app/models/concerns/standings.rb::ClassMethods.tie_breaker"]);
  });

  it("calls a module's methods on the module after `extend self` or `module_function :name`", () => {
    expect(linksOf("FixtureService.label", "League::Slugs.slug")).toEqual(["lib/league/slugs.rb::Slugs.slug"]);
    expect(linksOf("Slugs.slug", "clean")).toEqual(["lib/league/slugs.rb::Slugs.clean"]);
    expect(linksOf("FixtureService.label", "League::Pads.pad")).toEqual(["lib/league/pads.rb::League::Pads.pad"]);
    expect(linksOf("League::Pads.trim", "pad")).toEqual(["lib/league/pads.rb::League::Pads.pad"]);
  });
});
