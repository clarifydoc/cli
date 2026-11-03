import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/** Analyze `files` as one Ruby project and return its summary. */
async function analyzeRuby(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-paths-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const linksOf = (summary: ProjectAnalysis, symbol: string, callName: string) =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.callName === callName).map((l) => `${l.targetFile}::${l.targetSymbol}`);

const clubIn = (ns: string | null, tag: string) =>
  ns
    ? `module ${ns}\n  class Club\n    def self.find(id)\n      new\n    end\n\n    def tally\n      "${tag}"\n    end\n\n    def full_name\n      "${tag}"\n    end\n\n    def promote!(by)\n      by\n    end\n  end\nend\n`
    : `class Club\n  def self.find(id)\n    new\n  end\n\n  def tally\n    "${tag}"\n  end\n\n  def full_name\n    "${tag}"\n  end\n\n  def promote!(by)\n    by\n  end\nend\n`;

describe("Ruby constant paths: calls read off them", () => {
  it("reads `League::Club.find(…)` as one call on the path, never `Club.find`", () => {
    const [run] = extractWithRegex("class FixtureList\n  def run(id)\n    League::Club.find(id)\n  end\nend\n", "app/services/fixture_list.rb", "ruby").classes[0]!.methods;
    expect(run!.calls.map((c) => c.name)).toEqual(["League::Club.find"]);
  });

  it("reads the parameters of `def look a, b`", () => {
    const [look] = extractWithRegex("class FixtureList\n  def look a, b = 2\n    a.full_name\n  end\nend\n", "app/services/fixture_list.rb", "ruby").classes[0]!.methods;
    expect(look!.params.map((p) => p.name)).toEqual(["a", "b"]);
    // `a` is the parameter, never a call of a method named `a`.
    expect(look!.calls.map((c) => c.name)).not.toContain("a");
  });
});

describe("Ruby constant paths: a type written `League::Club` is the Club of module League", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRuby({
      "app/models/league/club.rb": clubIn("League", "league"),
      // The decoy: a top-level Club with the same members.
      "app/models/club.rb": clubIn(null, "top"),
      "app/models/league/helper.rb": "module League\n  class Helper\n    def assist\n      1\n    end\n  end\nend\n",
      "app/models/helper.rb": "class Helper\n  def assist\n    2\n  end\nend\n",
      "app/models/billing/report.rb": "module Billing\n  class Report\n    def total\n      3\n    end\n  end\nend\n",
      "app/models/report.rb": "class Report\n  def total\n    4\n  end\nend\n",
      "app/models/coach.rb": "class Coach\n  def drill\n    5\n  end\nend\n",
      "app/models/garage/store.rb": "module Garage\n  class Store\n    def self.with\n      yield\n    end\n  end\nend\n",
      "app/mailers/club_mailer.rb": "class ClubMailer < ApplicationMailer\n  def notify\n    1\n  end\nend\n",
      "app/jobs/club_mail_job.rb": "class ClubMailJob\n  def perform\n    Garage::Store.with { 1 }\n    ClubMailer.with(club: 1).notify\n  end\nend\n",
      "app/services/fixture_list.rb": `class FixtureList
  def initialize
    @club = League::Club.new
  end

  def run(id)
    League::Club.find(id)
    League::Club.new.tally
    @club.full_name
    h = League::Helper.new
    h.assist
    report = Billing::Report.new
    report.total
    Billing::Coach.new.drill
    League::Club.new.promote!(params.require(:by))
  end
end
`,
    }));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("links a class call on the path to the namespaced class", () => {
    expect(linksOf(summary, "FixtureList.run", "League::Club.find")).toEqual(["app/models/league/club.rb::Club.find"]);
    expect(linksOf(summary, "FixtureList.run", "Club.find")).toEqual([]);
  });

  it("types a construction, a field and a local by the path", () => {
    expect(linksOf(summary, "FixtureList.run", "new.tally")).toEqual(["app/models/league/club.rb::Club.tally"]);
    expect(linksOf(summary, "FixtureList.run", "club.full_name")).toEqual(["app/models/league/club.rb::Club.full_name"]);
    expect(linksOf(summary, "FixtureList.run", "h.assist")).toEqual(["app/models/league/helper.rb::Helper.assist"]);
    expect(linksOf(summary, "FixtureList.run", "report.total")).toEqual(["app/models/billing/report.rb::Report.total"]);
  });

  it("keeps a bang method's `!` through a typed receiver", () => {
    expect(summary.symbolLinks.filter((l) => l.sourceSymbol === "FixtureList.run" && l.callName === "new.promote!").map((l) => `${l.targetFile}::${l.targetSymbol} ${l.strategy}`))
      .toEqual(["app/models/league/club.rb::Club.promote! injection"]);
  });

  it("never takes another class's method for one called on a project class that lacks it", () => {
    expect(linksOf(summary, "ClubMailJob.perform", "Garage::Store.with")).toEqual(["app/models/garage/store.rb::Store.with"]);
    expect(linksOf(summary, "ClubMailJob.perform", "ClubMailer.with")).toEqual([]);
  });

  it("records a namespaced construction as a call of the class it names", () => {
    expect(linksOf(summary, "FixtureList.run", "League::Helper.new")).toEqual(["app/models/league/helper.rb::Helper"]);
    expect(linksOf(summary, "FixtureList.initialize", "League::Club.new")).toEqual(["app/models/league/club.rb::Club"]);
  });

  it("links nothing through a path no class is declared at, whatever its last name", () => {
    expect(linksOf(summary, "FixtureList.run", "new.drill")).toEqual([]);
  });
});
