import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { analyze } from "../../../core/analyzer.js";
import { loadReportSummary } from "../../../core/report-payload.js";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { ProjectAnalysis } from "../../../types/analysis.js";

async function analyzeRails(files: Record<string, string>): Promise<{ summary: ProjectAnalysis; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "cd-ruby-devise-"));
  for (const [rel, text] of Object.entries({ Gemfile: 'source "https://rubygems.org"\ngem "rails"\ngem "devise"\n', ...files })) {
    await mkdir(dirname(join(dir, "repo", rel)), { recursive: true });
    await writeFile(join(dir, "repo", rel), text);
  }
  await analyze({ projectRoot: join(dir, "repo"), outputDir: join(dir, "out"), lsp: false, gitHistory: false });
  return { summary: await loadReportSummary(join(dir, "out")), dir };
}

const MODELS: Record<string, string> = {
  "app/models/application_record.rb": "class ApplicationRecord < ActiveRecord::Base\n  self.abstract_class = true\nend\n",
  "app/models/player.rb": `class Player < ApplicationRecord
  include Scorable
  devise :database_authenticatable, :registerable,
         :recoverable, :rememberable, :validatable, :confirmable
  belongs_to :club
end
`,
  // Inherits Player's \`devise\` line.
  "app/models/captain.rb": "class Captain < Player\nend\n",
  "app/models/coach.rb": "class Coach < ApplicationRecord\n  devise :database_authenticatable, :lockable, :omniauthable, omniauth_providers: %i[github]\nend\n",
  // States no `devise` line: a `devise_for` naming it draws nothing.
  "app/models/referee.rb": "class Referee < ApplicationRecord\n  def retire\n    destroy\n  end\nend\n",
  "app/models/club.rb": "class Club < ApplicationRecord\n  include Scorable\n  has_many :players\nend\n",
  // A concern only a plain class includes.
  "app/models/concerns/rankable.rb": "module Rankable\n  extend ActiveSupport::Concern\n\n  def promote!\n    update!(rank: 1)\n  end\nend\n",
  "app/services/table_printer.rb": "class TablePrinter\n  include Rankable\nend\n",
  "app/models/concerns/scorable.rb": `module Scorable
  extend ActiveSupport::Concern

  class InvalidScore < StandardError
    def reset
      save!
    end
  end

  def add_goal!(count)
    update!(goals: goals + count)
  end

  def reset_score
    update_columns(goals: 0)
    save!
  end

  def retire
    destroy
  end
end
`,
  "db/schema.rb": `ActiveRecord::Schema[7.1].define(version: 2024_01_01_000000) do
  create_table "clubs" do |t|
    t.integer "goals"
  end
  create_table "players" do |t|
    t.integer "goals"
  end
  create_table "referees" do |t|
    t.string "name"
  end
  create_table "coaches" do |t|
    t.string "email"
  end
end
`,
};

describe("devise_for draws the routes of the modules the model's devise line enables", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRails({
      ...MODELS,
      "config/initializers/devise.rb": "Devise.setup do |config|\n  config.sign_out_via = :delete\n  # config.omniauth :gitlab, 'id', 'secret'\nend\n",
      "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
      "app/controllers/staff/sessions_controller.rb": "module Staff\n  class SessionsController < Devise::SessionsController\n    def create\n      super\n    end\n  end\nend\n",
      "config/routes.rb": `Rails.application.routes.draw do
  devise_for :players, path: "squad", controllers: { sessions: "staff/sessions" },
                       skip: [:registrations]
  devise_for :captains, only: :sessions, path_names: { sign_in: "login" }
  scope "/staff" do
    devise_for :coaches
  end
  namespace :league do
    devise_for :players, skip: :all
    devise_for :players, only: [:passwords]
  end
  devise_for :referees
end
`,
    }));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const rows = () => summary.routeMap.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`).sort();

  it("draws each enabled module at Devise's paths, on the controllers `controllers:` and the scope name", () => {
    expect(rows()).toEqual(
      [
        // Player: sessions (a project controller), passwords, confirmations; registrations skipped.
        "GET /squad/sign_in Staff::SessionsController#new",
        "POST /squad/sign_in Staff::SessionsController#create",
        "DELETE /squad/sign_out Staff::SessionsController#destroy",
        "GET /squad/password/new Devise::PasswordsController#new",
        "GET /squad/password/edit Devise::PasswordsController#edit",
        "PATCH /squad/password Devise::PasswordsController#update",
        "PUT /squad/password Devise::PasswordsController#update",
        "POST /squad/password Devise::PasswordsController#create",
        "GET /squad/confirmation/new Devise::ConfirmationsController#new",
        "GET /squad/confirmation Devise::ConfirmationsController#show",
        "POST /squad/confirmation Devise::ConfirmationsController#create",
        // Captain inherits Player's modules; `only:` and `path_names:` narrow and rename.
        "GET /captains/login Devise::SessionsController#new",
        "POST /captains/login Devise::SessionsController#create",
        "DELETE /captains/sign_out Devise::SessionsController#destroy",
        // Coach under `scope "/staff"`: sessions, unlocks, and the model's OmniAuth provider.
        "GET /staff/coaches/sign_in Devise::SessionsController#new",
        "POST /staff/coaches/sign_in Devise::SessionsController#create",
        "DELETE /staff/coaches/sign_out Devise::SessionsController#destroy",
        "GET /staff/coaches/unlock/new Devise::UnlocksController#new",
        "GET /staff/coaches/unlock Devise::UnlocksController#show",
        "POST /staff/coaches/unlock Devise::UnlocksController#create",
        "POST /staff/coaches/auth/github Devise::OmniauthCallbacksController#passthru",
        "GET /staff/coaches/auth/github/callback Devise::OmniauthCallbacksController#github",
        "POST /staff/coaches/auth/github/callback Devise::OmniauthCallbacksController#github",
        // In `namespace :league` Devise takes the namespace's module for its controllers.
        "GET /league/players/password/new League::PasswordsController#new",
        "GET /league/players/password/edit League::PasswordsController#edit",
        "PATCH /league/players/password League::PasswordsController#update",
        "PUT /league/players/password League::PasswordsController#update",
        "POST /league/players/password League::PasswordsController#create",
        // Referee states no `devise` line: nothing is drawn for it.
      ].sort(),
    );
  });

  it("names the rows with Devise's helpers", () => {
    const names = Object.fromEntries(summary.routeMap.filter((r) => r.name).map((r) => [`${r.httpMethod} ${r.path}`, r.name]));
    expect(names["GET /squad/sign_in"]).toBe("new_player_session");
    expect(names["DELETE /squad/sign_out"]).toBe("destroy_player_session");
    expect(names["GET /squad/password/edit"]).toBe("edit_player_password");
    expect(names["GET /staff/coaches/auth/github/callback"]).toBe("coach_github_omniauth_callback");
    expect(names["POST /league/players/password"]).toBe("league_player_password");
  });

  it("gives a row Devise's own controller serves the access that action has on the model", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`);
    expect(flows).toContain("POST /squad/password db-write Player");
    expect(flows).toContain("GET /staff/coaches/unlock db-write Coach");
    // A project override calling `super` runs the gem's action.
    expect(flows).toContain("POST /squad/sign_in db-read Player");
    // A form the action only renders reaches nothing.
    expect(flows.some((f) => f.startsWith("GET /squad/password/new "))).toBe(false);
  });
});

describe("a concern's bare ActiveRecord verbs write each including model's table", () => {
  let summary: ProjectAnalysis;
  let dir: string;
  beforeAll(async () => {
    ({ summary, dir } = await analyzeRails({
      ...MODELS,
      "app/controllers/application_controller.rb": "class ApplicationController < ActionController::Base\nend\n",
      "app/controllers/referees_controller.rb": "class RefereesController < ApplicationController\n  def destroy\n    Referee.find(params[:id]).retire\n  end\nend\n",
      "config/routes.rb": "Rails.application.routes.draw do\n  resources :referees, only: [:destroy]\nend\n",
    }));
  }, 60_000);
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("puts one write per including model on each concern method", () => {
    const writes = (symbol: string) =>
      (summary.symbolDataAccess ?? []).filter((s) => s.symbol === symbol && s.file === "app/models/concerns/scorable.rb").map((s) => `${s.entity}: ${s.sites.map((x) => x.name).join(",")}`).sort();
    expect(writes("Scorable.add_goal!")).toEqual(["Club: Club.update!", "Player: Player.update!"]);
    expect(writes("Scorable.reset_score")).toEqual(["Club: Club.update_columns,Club.save!", "Player: Player.update_columns,Player.save!"]);
    expect(writes("Scorable.retire")).toEqual(["Club: Club.destroy", "Player: Player.destroy"]);
  });

  it("writes nothing for a concern no model includes, nor from a class nested in a concern", () => {
    const accesses = summary.symbolDataAccess ?? [];
    expect(accesses.filter((s) => s.file === "app/models/concerns/rankable.rb")).toEqual([]);
    expect(accesses.filter((s) => s.symbol.startsWith("Scorable::InvalidScore") || s.symbol === "InvalidScore.reset")).toEqual([]);
  });

  it("leaves a model that does not include the concern to its own methods", () => {
    const flows = (summary.dataFlows ?? []).filter((f) => f.entryKind === "route").map((f) => `${f.entryLabel} ${f.effect} ${f.resource}`);
    expect(flows).toContain("DELETE /referees/:id db-write Referee");
    expect(flows.filter((f) => f.startsWith("DELETE /referees/:id db-write")).sort()).toEqual(["DELETE /referees/:id db-write Referee"]);
  });
});

describe("Class.new(Base) with a brace block", () => {
  it("is a class ending at its closing brace, like the do…end form", () => {
    const source = `class StrikerFactory
  Striker = Class.new(Player) {
    def shoot
      Club.find(1)
    end
  }

  Keeper = Class.new(Player) do
    def save_shot
      Club.find(2)
    end
  end

  def build
    Club.create!(name: "x")
  end
end
`;
    const { classes } = extractWithRegex(source, "app/services/striker_factory.rb", "ruby");
    const shape = classes.map((c) => `${c.name} < ${c.extends ?? "-"} ${c.line}-${c.endLine}: ${c.methods.map((m) => `${m.name}@${m.line}-${m.endLine}`).join(",")}`);
    expect(shape).toEqual([
      "StrikerFactory < - 1-17: build@14-16",
      "Striker < Player 2-6: shoot@3-5",
      "Keeper < Player 8-12: save_shot@9-11",
    ]);
  });
});
