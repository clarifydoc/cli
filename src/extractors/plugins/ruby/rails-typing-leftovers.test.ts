import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

const model = (name: string, body: string, parent = "ApplicationRecord") => `class ${name} < ${parent}\n${body}end\n`;
const concern = (name: string, body: string) =>
  `module ${name}\n  extend ActiveSupport::Concern\n${body}end\n`;

describe("Current.<attr> from a typed local, associations inherited or declared in nested concerns", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-typing-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n',
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\nend\n",
      // Person declares `trophies` and takes `badges` through a concern that includes another concern.
      "app/models/person.rb": model("Person", "  include Rosterable\n  has_many :trophies\n"),
      "app/models/player.rb": model("Player", "", "Person"),
      // The decoys: the same association names, other targets.
      "app/models/coach.rb": model("Coach", '  has_many :trophies, class_name: "Medal"\n'),
      "app/models/fan.rb": model("Fan", '  has_many :badges, class_name: "Pin"\n'),
      "app/models/trophy.rb": model("Trophy", ""),
      "app/models/medal.rb": model("Medal", ""),
      "app/models/badge.rb": model("Badge", ""),
      "app/models/pin.rb": model("Pin", ""),
      "app/models/concerns/rosterable.rb": concern("Rosterable", "  include Badged\n"),
      "app/models/concerns/badged.rb": concern("Badged", "  included do\n    has_many :badges\n  end\n"),
      "app/models/current.rb": "class Current < ActiveSupport::CurrentAttributes\n  attribute :user, :boss, :ghost\nend\n",
      "app/controllers/application_controller.rb": [
        "class ApplicationController < ActionController::Base",
        "  def set_current",
        "    user = Player.find(params[:id])",
        "    Current.user = user",
        "    boss = Coach.find(1)",
        "    Current.boss = boss",
        "  end",
        "",
        "  def set_ghost(ghost)",
        "    Current.ghost = ghost", // a parameter: states nothing
        "  end",
        "end",
        "",
      ].join("\n"),
      "app/controllers/squads_controller.rb": [
        "class SquadsController < ApplicationController",
        "  def show",
        "    @a = Current.user.trophies.find(params[:id])", // 3: inherited from Person
        "    @b = Current.boss.trophies.find(params[:id])", // 4: Coach's own
        "    @c = Current.user.badges.find(params[:id])", // 5: nested concern of Person
        "    @d = Current.ghost.trophies.find(params[:id])", // 6: untyped
        "  end",
        "end",
        "",
      ].join("\n"),
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

  it("types Current.user from the local it is assigned, through an inherited association", () => {
    expect(entityOf("Current.user.trophies.find", 3)).toEqual(["Trophy"]);
  });

  it("keeps a namesake association of another model apart", () => {
    expect(entityOf("Current.boss.trophies.find", 4)).toEqual(["Medal"]);
  });

  it("reaches an association a concern includes through another concern", () => {
    expect(entityOf("Current.user.badges.find", 5)).toEqual(["Badge"]);
  });

  it("types nothing from a parameter", () => {
    const got = entityOf("Current.ghost.trophies.find", 6);
    expect(got).not.toContain("Trophy");
    expect(got).not.toContain("Medal");
  });
});
