import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function analyzeRuby(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-chain-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const targetsOf = (summary: ProjectAnalysis, symbol: string, line: number) =>
  summary.symbolLinks.filter((l) => l.sourceSymbol === symbol && l.sourceLine === line && l.relation === "calls").map((l) => `${l.targetFile}::${l.targetSymbol}`);
const onPlayer = (summary: ProjectAnalysis, symbol: string, line: number) => targetsOf(summary, symbol, line).filter((t) => t.startsWith("app/models/player.rb::Player.") && t.endsWith("!"));

describe("Ruby chains with arguments mid-way", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRuby({
      "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
      "app/models/team.rb": "class Team < ApplicationRecord\n  has_many :players\n\n  def lineup\n    players.find_by(id: 1).injure!\n    players.where(id: size(2)).first.heal!\n    players.find_by!(id: 1).bench!\n  end\nend\n",
      "app/models/player.rb": "class Player < ApplicationRecord\n  belongs_to :team\n\n  def injure!\n    update(injured: true)\n  end\n\n  def heal!\n    update(injured: false)\n  end\n\n  def bench!\n    update(benched: true)\n  end\nend\n",
      "app/models/mascot.rb": "class Mascot\n  def injure!\n    nil\n  end\n\n  def heal!\n    nil\n  end\n\n  def bench!\n    nil\n  end\n\n  def find_by(id:)\n    self\n  end\nend\n",
      "app/services/roster.rb": `class Roster
  def show(id)
    team = Team.find(id)
    team.players.find_by(id: 1).injure!
    team.players.where(id: 1).first.heal!
    Team.find(1).players.find_by(id: 1).bench!
  end
end
`,
    }));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves the call after an association's finder with arguments on the model", () => {
    expect(onPlayer(summary, "Team.lineup", 5)).toEqual(["app/models/player.rb::Player.injure!"]);
    expect(onPlayer(summary, "Team.lineup", 6)).toEqual(["app/models/player.rb::Player.heal!"]);
    expect(onPlayer(summary, "Team.lineup", 7)).toEqual(["app/models/player.rb::Player.bench!"]);
  });

  it("does the same from a typed local and from a class chain", () => {
    expect(onPlayer(summary, "Roster.show", 4)).toEqual(["app/models/player.rb::Player.injure!"]);
    expect(onPlayer(summary, "Roster.show", 5)).toEqual(["app/models/player.rb::Player.heal!"]);
    expect(onPlayer(summary, "Roster.show", 6)).toEqual(["app/models/player.rb::Player.bench!"]);
  });
});
