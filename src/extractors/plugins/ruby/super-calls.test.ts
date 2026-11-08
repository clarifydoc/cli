import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";

describe("ruby super in an admin gem controller", () => {
  it("an override calling super reaches the gem action's model write; a namesake without super does not (end to end)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-ruby-super-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "administrate"\n',
      "config/routes.rb": `Rails.application.routes.draw do
  namespace :admin do
    resources :clubs, only: [:update]
    resources :players, only: [:update]
  end
end
`,
      "app/controllers/admin/application_controller.rb": `module Admin
  class ApplicationController < Administrate::ApplicationController
  end
end
`,
      "app/controllers/admin/clubs_controller.rb": `module Admin
  class ClubsController < Admin::ApplicationController
    def update
      requested_resource.touch_season
      super
    end
  end
end
`,
      "app/controllers/admin/players_controller.rb": `module Admin
  class PlayersController < Admin::ApplicationController
    def update
      requested_resource.touch_season
      redirect_to admin_players_path
    end
  end
end
`,
      "app/models/club.rb": "class Club < ApplicationRecord\nend\n",
      "app/models/player.rb": "class Player < ApplicationRecord\nend\n",
    };
    try {
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
        await writeFile(join(dir, "repo", rel), text);
      }
      await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
      const summary = await loadReportSummary(join(dir, "out"));
      const flows = (summary.dataFlows ?? []).map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`).sort();
      expect(flows).toEqual(["PATCH /admin/clubs/:id db-write Club", "PUT /admin/clubs/:id db-write Club"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ruby instance variables typed by a model constant or another variable", () => {
  it("`@fixture = Match.find` types `@fixture.update!`, and `@subject ||= @fixture` carries it; a variable of params is no model (end to end)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cd-ruby-ivar-"));
    const files: Record<string, string> = {
      Gemfile: 'source "https://rubygems.org"\ngem "rails"\n',
      "config/routes.rb": `Rails.application.routes.draw do
  resources :fixtures, only: [:update]
  resources :results, only: [:update]
  resources :things, only: [:update]
end
`,
      "app/controllers/fixtures_controller.rb": `class FixturesController < ApplicationController
  before_action :set_fixture

  def update
    @fixture.update!(score: params[:score])
  end

  private

  def set_fixture
    @fixture = Match.find(params[:id])
  end
end
`,
      "app/controllers/results_controller.rb": `class ResultsController < FixturesController
  def update
    subject.update!(score: 0)
  end

  private

  def subject
    @subject ||= @fixture
  end
end
`,
      // A namesake shape whose variable is plain request data: no model is named.
      "app/controllers/things_controller.rb": `class ThingsController < ApplicationController
  def update
    @thing = params[:thing]
    @thing.update!(open: true)
  end
end
`,
      "app/models/match.rb": "class Match < ApplicationRecord\nend\n",
    };
    try {
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
        await writeFile(join(dir, "repo", rel), text);
      }
      await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
      const summary = await loadReportSummary(join(dir, "out"));
      const flows = (summary.dataFlows ?? []).filter((f) => f.effect === "db-write").map((f) => `${f.entryLabel} ${f.resource}`).sort();
      expect(flows).toEqual(["PATCH /fixtures/:id Match", "PATCH /results/:id Match", "PUT /fixtures/:id Match", "PUT /results/:id Match"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
