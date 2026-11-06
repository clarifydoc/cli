import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

describe("ActiveRecord member names on a receiver the project cannot type", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-untyped-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\n',
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\nend\n",
      "app/models/team.rb": "class Team < ApplicationRecord\n  has_many :players\n\n  def lineup\n    players.find_by(id: 1)\n    squad.find_by(id: 2)\n    squad.save\n    squad.rename\n  end\nend\n",
      "app/models/player.rb": "class Player < ApplicationRecord\n  def save\n    super\n  end\nend\n",
      // The decoy: a plain class that defines the same names.
      "app/models/mascot.rb": "class Mascot\n  def self.find_by(name)\n    nil\n  end\n\n  def rename\n    1\n  end\nend\n",
      "app/services/roster.rb": "class Roster\n  def show(player_id)\n    Mascot.find_by(1)\n    p = Player.find(player_id)\n    p.save\n  end\nend\n",
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

  const at = (symbol: string, line: number) =>
    summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.sourceLine === line && l.relation === "calls").map((l) => `${l.targetFile}::${l.targetSymbol}`);

  it("never links a query or persistence name to the one class that happens to define it", () => {
    expect(at("Team.lineup", 5).filter((t) => t.includes("Mascot"))).toEqual([]);
    expect(at("Team.lineup", 6).filter((t) => t.includes("Mascot"))).toEqual([]);
  });

  it("still links a name that is not a model member, and an explicitly stated receiver", () => {
    expect(at("Team.lineup", 8)).toContain("app/models/mascot.rb::Mascot.rename");
    expect(at("Roster.show", 3)).toContain("app/models/mascot.rb::Mascot.find_by");
  });

  it("keeps a typed receiver whose class overrides the member", () => {
    expect(at("Roster.show", 5)).toContain("app/models/player.rb::Player.save");
  });
});
