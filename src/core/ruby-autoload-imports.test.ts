import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "./analyzer.js";
import { loadReportSummary } from "./report-payload.js";
import type { ProjectAnalysis } from "../types/analysis.js";

/**
 * Rails names no file in a `require`: a constant is loaded from the file its
 * name spells (Zeitwerk). The constants a file names are its imports, so a
 * unique-name method link needs one of them — or a receiver named for the
 * class — and an ActiveRecord call that only shares a name with a method of
 * an unrelated file (a Rake task's `find_by`, a service's `update!`) stays
 * unlinked (real-repo shape).
 */
const FILES: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\ngem 'rails'\n",
  "app/models/club.rb": `class Club < ApplicationRecord
  def promote!
    update!(division: division - 1)
  end
end
`,
  "app/models/match_report.rb": `class MatchReport < ApplicationRecord
  def publish_summary
    update!(published: true)
  end
end
`,
  "app/services/league/standings_service.rb": `module League
  class StandingsService
    def refresh_table
      true
    end
  end
end
`,
  "app/services/transfer/window_service.rb": `class Transfer::WindowService
  def update!(attrs)
    attrs
  end
end
`,
  "lib/tasks/import_clubs.rake": `class CsvRow
  def find_by(name)
    name
  end
end
`,
  "app/controllers/clubs_controller.rb": `class ClubsController < ApplicationController
  def refresh(standings)
    League::StandingsService.warm
    standings.refresh_table
  end

  def report
    match_report.publish_summary
  end

  def rename
    squad = Club.find(params[:id])
    squad.update!(name: params[:name])
    players.find_by(name: params[:name])
  end
end
`,
};

describe("Ruby constants as imports", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-autoload-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
      await writeFile(join(dir, "repo", rel), text);
    }
    await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 180_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const linkOf = (symbol: string, callName: string) => {
    const link = summary.symbolLinks.find((l) => l.sourceSymbol === symbol && l.callName === callName);
    return link ? `${link.targetFile} ${link.targetSymbol} ${link.strategy}` : null;
  };

  it("links a unique method of a class the file names by constant", () => {
    expect(linkOf("ClubsController.refresh", "standings.refresh_table")).toBe(
      "app/services/league/standings_service.rb StandingsService.refresh_table unique-global",
    );
  });

  it("links a unique method of the class a receiver is named for", () => {
    expect(linkOf("ClubsController.report", "match_report.publish_summary")).toBe(
      "app/models/match_report.rb MatchReport.publish_summary unique-global",
    );
  });

  it("leaves an ActiveRecord call sharing a name with an unrelated file's method unlinked", () => {
    expect(linkOf("ClubsController.rename", "squad.update!")).toBeNull();
    expect(linkOf("ClubsController.rename", "players.find_by")).toBeNull();
  });
});
