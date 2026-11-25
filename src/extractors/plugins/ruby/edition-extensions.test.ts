import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

/**
 * An edition's extension modules (real-repo FP): `Api::V1::RatingsController.prepend_mod_with('Api::V1::RatingsController')`
 * prepends `Enterprise::Api::V1::RatingsController` at boot. An action only the module defines serves its route; one
 * both define is the module's (prepend answers first). Decoy: a namesake module under another namespace.
 */
const FILES: Record<string, string> = {
  "Gemfile": "source 'https://rubygems.org'\ngem 'rails', '~> 7.1'\n",
  "config/routes.rb": `Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :ratings, only: [:index] do
        member do
          patch :update if LeagueApp.enterprise?
        end
      end
      resources :fixtures, only: [:destroy]
    end
  end
end
`,
  "app/models/rating.rb": "class Rating < ApplicationRecord\nend\n",
  "app/models/fixture.rb": "class Fixture < ApplicationRecord\nend\n",
  "app/models/archived_fixture.rb": "class ArchivedFixture < ApplicationRecord\nend\n",
  "app/controllers/api/v1/ratings_controller.rb": `class Api::V1::RatingsController < ApplicationController
  def index
    @ratings = Rating.all
  end
end

Api::V1::RatingsController.prepend_mod_with('Api::V1::RatingsController')
`,
  "app/controllers/api/v1/fixtures_controller.rb": `class Api::V1::FixturesController < ApplicationController
  def destroy
    fixture = Fixture.find(params[:id])
    fixture.destroy!
  end
end

Api::V1::FixturesController.prepend_mod_with('Api::V1::FixturesController')
`,
  "enterprise/app/controllers/enterprise/api/v1/ratings_controller.rb": `module Enterprise::Api::V1::RatingsController
  def update
    rating = Rating.find(params[:id])
    rating.update!(score: params[:score])
  end
end
`,
  "enterprise/app/controllers/enterprise/api/v1/fixtures_controller.rb": `module Enterprise::Api::V1::FixturesController
  def destroy
    ArchivedFixture.create!(fixture_id: params[:id])
    super
  end
end
`,
  "lib/archive/ratings_controller.rb": `module Archive::Api::V1::RatingsController
  def update
    Rating.delete_all
  end
end
`,
};

describe("Rails edition extensions prepended with prepend_mod_with", () => {
  let dir: string;
  let summary: ProjectAnalysis;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "cd-ruby-editions-"));
    for (const [rel, text] of Object.entries(FILES)) {
      await mkdir(dirname(join(dir, "app", rel)), { recursive: true });
      await writeFile(join(dir, "app", rel), text);
    }
    await analyze({ projectRoot: join(dir, "app"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
    summary = await loadReportSummary(join(dir, "out"));
  }, 120_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serves a route by the action only the prepended module defines, and reaches its table", () => {
    const row = summary.routeMap.find((r) => r.path === "/api/v1/ratings/:id")!;
    expect(row.filePath).toBe("enterprise/app/controllers/enterprise/api/v1/ratings_controller.rb");
    expect((summary.dataFlows ?? []).filter((f) => f.entryLabel?.endsWith("/api/v1/ratings/:id") && f.effect === "db-write").map((f) => f.resource)).toEqual(["Rating"]);
  });

  it("takes the prepended module's action before the class's own, its `super` the class's, never a namesake module elsewhere", () => {
    const row = summary.routeMap.find((r) => r.path === "/api/v1/fixtures/:id")!;
    expect(row.filePath).toBe("enterprise/app/controllers/enterprise/api/v1/fixtures_controller.rb");
    const sup = summary.symbolLinks.filter((l) => l.sourceSymbol === "Enterprise::Api::V1::FixturesController.destroy" && l.callName === "super").map((l) => l.targetSymbol);
    expect(sup).toEqual(["Api::V1::FixturesController.destroy"]);
    const writes = (summary.dataFlows ?? []).filter((f) => f.entryLabel?.endsWith("/api/v1/fixtures/:id") && f.effect === "db-write").map((f) => f.resource).sort();
    expect(writes).toEqual(["ArchivedFixture", "Fixture"]);
    expect(summary.routeMap.some((r) => (r.filePath ?? "").startsWith("lib/archive"))).toBe(false);
  });
});
