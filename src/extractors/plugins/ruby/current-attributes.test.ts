import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const model = (name: string, body: string) => `class ${name} < ApplicationRecord\n${body}end\n`;

describe("request-scoped attributes (Current.<attr>) type the association chain they start", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-current-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n',
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\nend\n",
      // `members` is declared by two models with different targets: only the owner tells which.
      "app/models/league.rb": model("League", '  has_many :clubs\n  has_many :members, class_name: "Player"\n'),
      "app/models/club.rb": model("Club", '  has_many :players\n  has_many :members, class_name: "Staff"\n'),
      "app/models/player.rb": model("Player", ""),
      "app/models/staff.rb": model("Staff", ""),
      "app/models/trophy.rb": model("Trophy", ""),
      "app/models/current.rb": "class Current < ActiveSupport::CurrentAttributes\n  attribute :league, :club, :squad, :mystery\nend\n",
      "app/controllers/application_controller.rb": [
        "class ApplicationController < ActionController::Base",
        "  def set_current_league",
        "    Current.league = League.find(params[:league_id])",
        "  end",
        "",
        "  def set_current_squad",
        "    Current.squad = Club.find(1)",
        "    Current.squad = League.find(2)",
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/controllers/squads_controller.rb": [
        "class SquadsController < ApplicationController",
        "  def show",
        "    @a = Current.league.members.find(params[:id])", // 3: stated by the assignment
        "    @b = Current.club.members.find(params[:id])", // 4: no assignment, named like Club
        "    @c = Current.squad.members.find(params[:id])", // 5: two types assigned, none
        "    @d = Current.mystery.members.find(params[:id])", // 6: named like no model
        "  end",
        "end",
        "",
      ].join("\n"),
      // The shape of a service whose constructor parameter a YARD tag types.
      "app/services/sign.rb": "class Sign\n  # @param member [Player]\n  def initialize(member)\n    @member = member.reload\n  end\n\n  def perform\n    @member.update!(name: 'x')\n  end\nend\n",
      // The decoy: the same names, no tag.
      "app/services/release.rb": "class Release\n  def initialize(member)\n    @member = member.reload\n  end\n\n  def perform\n    @member.update!(name: 'x')\n  end\nend\n",
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
  const entityOf = (name: string, line: number) => calls().filter((c) => c.name === name && c.line === line).map((c) => c.entity);

  it("takes the association of the model the attribute is assigned", () => {
    expect(entityOf("Current.league.members.find", 3)).toEqual(["Player"]);
  });

  it("falls back to the model the attribute is named after", () => {
    expect(entityOf("Current.club.members.find", 4)).toEqual(["Staff"]);
  });

  it("types nothing from conflicting assignments or an attribute no model is named after", () => {
    for (const [name, line] of [["Current.squad.members.find", 5], ["Current.mystery.members.find", 6]] as const) {
      expect(entityOf(name, line)).not.toContain("Staff");
      expect(entityOf(name, line)).not.toContain("Player");
    }
  });

  it("types an instance variable assigned from a YARD-typed parameter, and only that one", () => {
    expect(calls().filter((c) => c.name === "@member.update!" && c.entity === "Player").length).toBe(1);
  });
});
