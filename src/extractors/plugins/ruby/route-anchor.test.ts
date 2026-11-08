import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";
import { railsRouteAnchor } from "./route-anchor.js";
import { reconcileProjectRoutes } from "../../route-resolvers/index.js";
import { buildImportIndex } from "../../../core/import-index.js";
import { buildClassIndex } from "../../../core/class-index.js";
import type { ClassInfo, FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

const cls = (name: string, ext: string | null, methods: Array<[string, number]>): ClassInfo =>
  ({
    name,
    extends: ext,
    implements: [],
    line: 1,
    endLine: 40,
    methods: methods.map(([n, line]) => ({ name: n, line, endLine: line + 1, params: [], calls: [] })),
    properties: [],
  }) as unknown as ClassInfo;

const file = (filePath: string, classes: ClassInfo[], routes = [] as FileAnalysis["routes"]): FileAnalysis =>
  ({ filePath, language: "ruby", projectId: "root", imports: [], exports: [], entityRelations: [], classes, routes }) as unknown as FileAnalysis;

describe("rails-route-anchor", () => {
  it("moves a routes.rb row onto the action that serves it, inherited actions onto their definer", () => {
    const router = `Rails.application.routes.draw do
  namespace :api do
    resources :labels, only: [:index, :show]
    resources :teams, only: [:index]
    resources :ghosts, only: [:index]
    resources :tags, only: [:index]
  end
end`;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/api/labels_controller.rb", [cls("Api::LabelsController", "Api::BaseController", [["index", 5], ["show", 9], ["export", 12]])], [
        // The plugin's guesses from action names: `show` is declared by the router, `export` is not
        // (dropped: the router names this controller and hands it to no gem's routing DSL).
        { path: "/api/labels/:id", httpMethod: "GET", kind: "api", handler: "Api::LabelsController#show", calls: [], middleware: ["before_action :authenticate_user!"], line: 9 },
        { path: "/api/labels/export", httpMethod: "GET", kind: "api", handler: "Api::LabelsController#export", calls: [], middleware: [], line: 12 },
      ]),
      file("app/controllers/api/base_controller.rb", [cls("Api::BaseController", null, [["index", 3]])]),
      file("app/controllers/api/teams_controller.rb", [cls("Api::TeamsController", "Api::BaseController", [])]),
      file("app/controllers/api/tags_controller.rb", [{ ...cls("Api::TagsController", "Api::BaseController", []), implements: ["LabelConcern"] } as ClassInfo]),
      file("app/controllers/concerns/label_concern.rb", [cls("LabelConcern", null, [["index", 7]])]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const where = out.flatMap((a) => a.routes.map((r) => `${r.httpMethod} ${r.path} @ ${a.filePath}:${r.line}`));
    expect(where.sort()).toEqual(
      [
        "GET /api/labels @ app/controllers/api/labels_controller.rb:5",
        "GET /api/labels/:id @ app/controllers/api/labels_controller.rb:9",
        "GET /api/teams @ app/controllers/api/base_controller.rb:3",
        // An included module's method comes before the superclass's.
        "GET /api/tags @ app/controllers/concerns/label_concern.rb:7",
        // No controller declares GhostsController: the row stays where it was declared.
        "GET /api/ghosts @ config/routes.rb:5",
      ].sort(),
    );
    expect(out[1]!.routes.filter((r) => r.resolvedBy === "rails-route-anchor")).toHaveLength(2);
    // The declared row keeps what the dropped guess knew about the controller's filters.
    expect(out[1]!.routes.find((r) => r.path === "/api/labels/:id")?.middleware).toEqual(["before_action :authenticate_user!"]);
  });
});

describe("rails-route-anchor — before_action filters", () => {
  it("gives an action the filters it runs, inherited ones first, honoring only:/skip", () => {
    const router = `Rails.application.routes.draw do
  namespace :api do
    resources :messages, only: [:index, :destroy]
  end
end`;
    const base = { ...cls("Api::BaseController", null, [["conversation", 6], ["authenticate", 10]]), decorators: ["before_action :authenticate", "before_action :conversation"] } as ClassInfo;
    const msgs = {
      ...cls("Api::MessagesController", "Api::BaseController", [["index", 4], ["destroy", 8], ["message", 12]]),
      decorators: ["skip_before_action :authenticate only: index", "before_action :message only: destroy"],
    } as ClassInfo;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/api/base_controller.rb", [base]),
      file("app/controllers/api/messages_controller.rb", [msgs]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const callsOf = (path: string, method: string) => out[2]!.routes.find((r) => r.path === path && r.httpMethod === method)!.calls.map((c) => c.name);
    expect(callsOf("/api/messages", "GET")).toEqual(["Api::BaseController.conversation"]);
    expect(callsOf("/api/messages/:id", "DELETE")).toEqual(["Api::BaseController.authenticate", "Api::BaseController.conversation", "Api::MessagesController.message"]);
    // The controller's own action method carries them too.
    expect(msgs.methods.find((m) => m.name === "destroy")!.calls.map((c) => c.name)).toContain("Api::MessagesController.message");
  });
});

describe("rails-route-anchor — guards a base controller declares", () => {
  it("gives every action its ancestors' guard filters, unless it skips them; loaders and feature switches guard nothing", () => {
    const router = `Rails.application.routes.draw do
  namespace :api do
    resources :fixtures, only: [:index, :show]
  end
  resources :fans, only: [:index]
end`;
    const app = { ...cls("ApplicationController", "ActionController::API", []), decorators: ["before_action :set_current_user"] } as ClassInfo;
    const base = {
      ...cls("Api::BaseController", "ApplicationController", []),
      decorators: ["before_action :authenticate_user!", "before_action :ensure_league_feature_enabled", "before_action :check_authorization"],
    } as ClassInfo;
    const fixtures = { ...cls("Api::FixturesController", "Api::BaseController", [["index", 4], ["show", 8]]), decorators: ["skip_before_action :check_authorization only: index"] } as ClassInfo;
    const fans = { ...cls("FansController", "ApplicationController", [["index", 3]]) } as ClassInfo;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/application_controller.rb", [app]),
      file("app/controllers/api/base_controller.rb", [base]),
      file("app/controllers/api/fixtures_controller.rb", [fixtures]),
      file("app/controllers/fans_controller.rb", [fans]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const auth = (path: string) => out.flatMap((a) => a.routes).find((r) => r.path === path)?.auth;
    expect(auth("/api/fixtures")?.policies).toEqual(["authenticate_user!"]);
    expect(auth("/api/fixtures")?.schemes).toEqual(["devise"]);
    expect(auth("/api/fixtures/:id")?.policies).toEqual(["authenticate_user!", "check_authorization"]);
    expect(auth("/api/fixtures/:id")?.inherited).toBe(true);
    expect(auth("/fans")).toBeUndefined();
  });
});

describe("rails-route-anchor — actions nothing serves", () => {
  it("drops a declared action the project's own controller chain never defines and no view renders; keeps gem-backed and view-backed ones", () => {
    const router = `Rails.application.routes.draw do
  namespace :api do
    resources :clubs, only: [:index, :new, :edit]
  end
  namespace :admin do
    resources :players, only: [:index]
  end
  resources :garages, only: [:new]
  resources :stadiums, only: [:new]
end`;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/application_controller.rb", [cls("ApplicationController", "ActionController::Base", [])]),
      file("app/controllers/api/base_controller.rb", [cls("Api::BaseController", "ApplicationController", [])]),
      file("app/controllers/api/clubs_controller.rb", [cls("Api::ClubsController", "Api::BaseController", [["index", 3]])]),
      file("app/views/api/clubs/index.json.jbuilder", []),
      // An admin framework's base supplies `index`: the project never writes it.
      file("app/controllers/admin/players_controller.rb", [cls("Admin::PlayersController", "Administrate::ApplicationController", [])]),
      file("app/controllers/garages_controller.rb", [cls("GaragesController", "ApplicationController", [])]),
      { ...file("app/views/garages/new.html.erb", []), language: "erb" } as FileAnalysis,
      // A module named like the controller, prepended at boot, defines `edit`.
      file("premium/app/controllers/premium/api/clubs_controller.rb", [cls("Premium::Api::ClubsController", null, [["edit", 2]])]),
      // No template of this controller is analyzed: its `new` may render one that is not (Haml).
      file("app/controllers/stadiums_controller.rb", [cls("StadiumsController", "ApplicationController", [])]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const paths = out.flatMap((a) => a.routes.map((r) => `${r.httpMethod} ${r.path}`));
    expect(paths.sort()).toEqual(["GET /admin/players", "GET /api/clubs", "GET /api/clubs/:id/edit", "GET /garages/new", "GET /stadiums/new"]);
  });
});

describe("rails-route-anchor — guesses for actions the router never names", () => {
  it("drops a routed controller's undeclared public helper, but keeps guesses on a controller a gem's DSL serves", () => {
    const router = `Rails.application.routes.draw do
  resources :clubs, only: [:index]
  devise_for :managers, controllers: { sessions: 'staff/sessions' }
  get 'staff/logout', to: 'staff/sessions#destroy'
end`;
    const guess = (handler: string, path: string, line: number) => ({ path, httpMethod: "GET", kind: "api", handler, calls: [], middleware: [], line });
    const facts: NonNullable<FileAnalysis["routeFacts"]> = [];
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb", [], facts)),
      file("app/controllers/application_controller.rb", [cls("ApplicationController", "ActionController::Base", [])]),
      file("app/controllers/clubs_controller.rb", [cls("ClubsController", "ApplicationController", [["index", 2], ["club_params", 6]])], [
        guess("ClubsController#index", "/clubs", 2),
        guess("ClubsController#club_params", "/clubs/club_params", 6),
      ] as FileAnalysis["routes"]),
      // `devise_for` routes this controller's `new`/`create`: the gem's DSL, not read here.
      file("app/controllers/staff/sessions_controller.rb", [cls("Staff::SessionsController", "Devise::SessionsController", [["new", 2], ["destroy", 5]])], [
        guess("Staff::SessionsController#new", "/staff/sessions/new", 2),
      ] as FileAnalysis["routes"]),
    ];
    out[0]!.routeFacts = facts;
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const handlers = out.flatMap((a) => a.routes.map((r) => r.handler)).sort();
    expect(handlers).toEqual(["ClubsController#index", "Staff::SessionsController#destroy", "Staff::SessionsController#new"]);
  });
});

describe("rails-route-anchor — a gem-based controller the router names itself", () => {
  it("drops the public helpers of an admin framework's controller its resources route (real-repo FP)", () => {
    const router = `Rails.application.routes.draw do
  namespace :back_office do
    resources :clubs, only: [:index, :show]
    resource :league_status, only: [:show]
  end
end`;
    const guess = (handler: string, path: string, line: number) => ({ path, httpMethod: "GET", kind: "api", handler, calls: [], middleware: [], line });
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/back_office/application_controller.rb", [cls("BackOffice::ApplicationController", "AdminKit::ApplicationController", [])]),
      file("app/controllers/back_office/clubs_controller.rb", [cls("BackOffice::ClubsController", "BackOffice::ApplicationController", [["scoped_resource", 2], ["resource_params", 6]])], [
        guess("BackOffice::ClubsController#scoped_resource", "/back_office/clubs/scoped_resource", 2),
        guess("BackOffice::ClubsController#resource_params", "/back_office/clubs/resource_params", 6),
      ] as FileAnalysis["routes"]),
      file("app/controllers/back_office/league_statuses_controller.rb", [cls("BackOffice::LeagueStatusesController", "BackOffice::ApplicationController", [["show", 2], ["season_label", 8]])], [
        guess("BackOffice::LeagueStatusesController#show", "/back_office/league_statuses/:id", 2),
        guess("BackOffice::LeagueStatusesController#season_label", "/back_office/league_statuses/season_label", 8),
      ] as FileAnalysis["routes"]),
      // The router never names it: the gem may route it, so its guess stays.
      file("app/controllers/back_office/reports_controller.rb", [cls("BackOffice::ReportsController", "BackOffice::ApplicationController", [["index", 2]])], [
        guess("BackOffice::ReportsController#index", "/back_office/reports", 2),
      ] as FileAnalysis["routes"]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const handlers = out.flatMap((a) => a.routes.map((r) => r.handler)).sort();
    expect(handlers).toEqual([
      "BackOffice::ClubsController#index",
      "BackOffice::ClubsController#show",
      "BackOffice::LeagueStatusesController#show",
      "BackOffice::ReportsController#index",
    ]);
  });
});

describe("rails-route-anchor — controllers the router never names", () => {
  const router = `Rails.application.routes.draw do
  resources :clubs, only: [:index]
end`;
  const guess = (handler: string, path: string, line: number) => ({ path, httpMethod: "GET", kind: "api", handler, calls: [], middleware: [], line });
  const run = (withRouter: boolean): string[] => {
    const out = [
      ...(withRouter ? [file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb"))] : []),
      file("app/controllers/application_controller.rb", [cls("ApplicationController", "ActionController::Base", [])]),
      file("app/controllers/clubs_controller.rb", [cls("ClubsController", "ApplicationController", [["index", 2]])], [
        guess("ClubsController#index", "/clubs", 2),
      ] as FileAnalysis["routes"]),
      file("app/controllers/reports_controller.rb", [cls("ReportsController", "ApplicationController", [["index", 2]])], [
        guess("ReportsController#index", "/reports", 2),
      ] as FileAnalysis["routes"]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    return out.flatMap((a) => a.routes.map((r) => r.handler!)).sort();
  };

  it("drops every guess of a controller no route names when the project has a router", () => {
    expect(run(true)).toEqual(["ClubsController#index"]);
  });

  it("keeps the guesses when no router was read", () => {
    expect(run(false)).toEqual(["ClubsController#index", "ReportsController#index"]);
  });
});

describe("rails-route-anchor — CRUD an admin gem's base class supplies", () => {
  it("gives a routed, unwritten action the access of the model its controller is named for; a namesake decoy and an unknown model get none", () => {
    const router = `Rails.application.routes.draw do
  namespace :admin do
    resources :clubs, only: [:index, :new, :create, :destroy]
    resources :match_reports, only: [:index]
    resources :garages, only: [:index]
  end
  resources :cars, only: [:index]
end`;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/admin/application_controller.rb", [cls("Admin::ApplicationController", "Administrate::ApplicationController", [])]),
      file("app/controllers/admin/clubs_controller.rb", [cls("Admin::ClubsController", "Admin::ApplicationController", [["scoped_resource", 4]])]),
      file("app/controllers/admin/match_reports_controller.rb", [cls("Admin::MatchReportsController", "Admin::ApplicationController", [["resource_class", 3]])]),
      // No `Garage` model in the project: nothing is invented.
      file("app/controllers/admin/garages_controller.rb", [cls("Admin::GaragesController", "Admin::ApplicationController", [])]),
      // Same shape on Rails' own base: no gem supplies anything.
      file("app/controllers/cars_controller.rb", [cls("CarsController", "ActionController::Base", [])]),
      file("app/models/club.rb", [cls("Club", "ApplicationRecord", [])]),
      file("app/models/match_report.rb", [cls("MatchReport", "ApplicationRecord", [])]),
      file("app/models/car.rb", [cls("Car", "ApplicationRecord", [])]),
      // A namesake in another namespace is not the model the gem resolves.
      file("app/models/premium/club.rb", [cls("Premium::Club", null, [])]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    for (const a of out) a.dataSources = [];
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const rows = out.flatMap((a) => a.dataSources.map((d) => `${d.handler} -> ${d.name} ${d.access}`));
    expect(rows.sort()).toEqual([
      "route:DELETE /admin/clubs/:id -> Club.destroy write",
      "route:GET /admin/clubs -> Club.all read",
      "route:POST /admin/clubs -> Club.create write",
    ]);
  });
});

describe("rails-route-anchor — an override that calls super on an admin gem's action", () => {
  it("adds the gem action's model access to the overriding route; an override without super, a project base and a decoy get none", () => {
    const router = `Rails.application.routes.draw do
  namespace :admin do
    resources :clubs, only: [:update]
    resources :players, only: [:update]
    resources :matches, only: [:update]
    resources :garages, only: [:update]
  end
end`;
    const withSuper = (c: ClassInfo, name: string, calls: string[]) => {
      c.methods.find((m) => m.name === name)!.calls = calls.map((n) => ({ name: n, kind: "internal", target: null, line: 5 })) as never;
      return c;
    };
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/admin/application_controller.rb", [cls("Admin::ApplicationController", "Administrate::ApplicationController", [])]),
      file("app/controllers/admin/clubs_controller.rb", [withSuper(cls("Admin::ClubsController", "Admin::ApplicationController", [["update", 5]]), "update", ["super"])]),
      // The override never calls super: it does its own thing.
      file("app/controllers/admin/players_controller.rb", [withSuper(cls("Admin::PlayersController", "Admin::ApplicationController", [["update", 5]]), "update", ["render"])]),
      // A project base defines `update` and `super` reaches that one.
      file("app/controllers/admin/base_matches_controller.rb", [cls("Admin::BaseMatchesController", "Admin::ApplicationController", [["update", 3]])]),
      file("app/controllers/admin/matches_controller.rb", [withSuper(cls("Admin::MatchesController", "Admin::BaseMatchesController", [["update", 5]]), "update", ["super"])]),
      // super on Rails' own base: no gem supplies a model.
      file("app/controllers/admin/garages_controller.rb", [withSuper(cls("Admin::GaragesController", "ActionController::Base", [["update", 5]]), "update", ["super"])]),
      file("app/models/club.rb", [cls("Club", "ApplicationRecord", [])]),
      file("app/models/player.rb", [cls("Player", "ApplicationRecord", [])]),
      file("app/models/match.rb", [cls("Match", "ApplicationRecord", [])]),
      file("app/models/garage.rb", [cls("Garage", "ApplicationRecord", [])]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    for (const a of out) a.dataSources = [];
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const rows = out.flatMap((a) => a.dataSources.map((d) => `${d.handler} -> ${d.name} ${d.access}`));
    expect(rows.sort()).toEqual(["route:PATCH /admin/clubs/:id -> Club.update write", "route:PUT /admin/clubs/:id -> Club.update write"]);
  });
});

describe("rails-route-anchor — devise_token_auth mounts reach the model they name", () => {
  it("sessions read and registrations write the mounted model; an override without super, an unknown model and a duplicated model get none", () => {
    const router = `Rails.application.routes.draw do
  mount_devise_token_auth_for 'Player', at: 'auth', controllers: {
    sessions: 'league_overrides/sessions',
    passwords: 'league_overrides/passwords'
  }, skip: [:omniauth_callbacks, :token_validations, :confirmations]
  mount_devise_token_auth_for 'Referee', at: 'referee_auth', skip: [:omniauth_callbacks, :token_validations, :confirmations, :passwords]
  mount_devise_token_auth_for 'Coach', at: 'coach_auth', skip: [:omniauth_callbacks, :token_validations, :confirmations, :passwords, :registrations]
end`;
    const facts: NonNullable<FileAnalysis["routeFacts"]> = [];
    const withSuper = (c: ClassInfo, name: string, calls: string[]) => {
      c.methods.find((m) => m.name === name)!.calls = calls.map((n) => ({ name: n, kind: "internal", target: null, line: 5 })) as never;
      return c;
    };
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb", [], facts)),
      // `create` calls super into the gem; the password override never does.
      file("app/controllers/league_overrides/sessions_controller.rb", [withSuper(cls("LeagueOverrides::SessionsController", "DeviseTokenAuth::SessionsController", [["create", 5]]), "create", ["super"])]),
      file("app/controllers/league_overrides/passwords_controller.rb", [cls("LeagueOverrides::PasswordsController", "DeviseTokenAuth::PasswordsController", [["create", 5], ["update", 9]])]),
      file("app/models/player.rb", [cls("Player", "ApplicationRecord", [])]),
      // Two classes named Referee: the mount does not say which.
      file("app/models/referee.rb", [cls("Referee", "ApplicationRecord", [])]),
      file("app/models/legacy/referee.rb", [cls("Referee", "ApplicationRecord", [])]),
      // No Coach class in the project: nothing is invented.
    ];
    out[0]!.routeFacts = facts;
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    for (const a of out) a.dataSources = [];
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const rows = out.flatMap((a) => a.dataSources.map((d) => `${d.handler} -> ${d.name} ${d.access}`));
    expect(rows.sort()).toEqual([
      "route:DELETE /auth -> Player.destroy write",
      "route:DELETE /auth/sign_out -> Player.find_for_authentication read",
      "route:GET /auth/password/edit -> Player.find read",
      "route:POST /auth -> Player.create write",
      "route:POST /auth/sign_in -> Player.find_for_authentication read",
      "route:PUT /auth -> Player.update write",
    ].sort());
  });
});

describe("rails-route-anchor — a concern's call through a reader typed by an instance variable", () => {
  it("calls the model's member when the reader's variable is typed (constant, association, alias); an untyped or ambiguous one keeps its name", () => {
    const router = `Rails.application.routes.draw do
  post '/labels/matches', to: 'match_labels#create'
  post '/labels/clubs', to: 'club_labels#create'
  post '/labels/cars', to: 'car_labels#create'
end`;
    const call = (name: string) => ({ name, kind: "internal", target: null, line: 3 }) as const;
    const concern = cls("LabelConcern", null, [["create", 2]]);
    concern.methods[0]!.calls = [call("model.update_labels")];
    const withValues = (c: ClassInfo, values: Record<string, string>, implementsModules: string[] = []) => ({ ...c, fieldValues: values, implements: implementsModules }) as ClassInfo;
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/concerns/label_concern.rb", [concern]),
      file("app/controllers/base_match_controller.rb", [withValues(cls("BaseMatchController", "ActionController::Base", [["load", 3]]), { match: "Match.find(params[:id])" })]),
      // Typed through an alias of the base's variable.
      file("app/controllers/match_labels_controller.rb", [withValues(cls("MatchLabelsController", "BaseMatchController", [["model", 4]]), { model: "@match" }, ["LabelConcern"])]),
      // Typed through an association one model declares.
      file("app/controllers/club_labels_controller.rb", [withValues(cls("ClubLabelsController", "ActionController::Base", [["model", 4]]), { model: "@club", club: "Current.league.clubs.find(params[:id])" }, ["LabelConcern"])]),
      // `@car` is never assigned: nothing is guessed.
      file("app/controllers/car_labels_controller.rb", [withValues(cls("CarLabelsController", "ActionController::Base", [["model", 4]]), { model: "@car" }, ["LabelConcern"])]),
      file("app/models/match.rb", [cls("Match", "ApplicationRecord", []), ].map((c) => ({ ...c, implements: ["Labelable"] }) as ClassInfo)),
      file("app/models/club.rb", [{ ...cls("Club", "ApplicationRecord", []), implements: ["Labelable"] } as ClassInfo]),
      file("app/models/concerns/labelable.rb", [cls("Labelable", null, [["update_labels", 2]])]),
    ];
    out[out.findIndex((a) => a.filePath === "app/models/club.rb")]!.entityRelations = [];
    // `Current.league.clubs` is the association `clubs` → Club.
    out[0]!.entityRelations = [{ fromEntity: "League", fromField: "clubs", toEntity: "Club" } as never];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const calls = (path: string) => out.flatMap((a) => a.routes).find((r) => r.path === path)!.calls.map((c) => c.name).filter((n) => /update_labels/.test(n));
    expect(calls("/labels/matches")).toEqual(["Labelable.update_labels"]);
    expect(calls("/labels/clubs")).toEqual(["Labelable.update_labels"]);
    expect(calls("/labels/cars")).toEqual(["model.update_labels"]);
  });
});

describe("rails-route-anchor — a concern's action calling a hook the including controller defines", () => {
  it("points each route's row at its own controller's hook, not the concern's placeholder", () => {
    const router = `Rails.application.routes.draw do
  post '/hooks/home', to: 'hooks/home#verify'
  post '/hooks/away', to: 'hooks/away#verify'
  post '/hooks/friendly', to: 'hooks/friendly#verify'
end`;
    const call = (name: string) => ({ name, kind: "internal", target: null, line: 3 }) as const;
    const concern = cls("VerifyConcern", null, [["verify", 2], ["valid_token?", 10]]);
    concern.methods[0]!.calls = [call("valid_token?"), call("render")];
    const out = [
      file("config/routes.rb", [], rubySpec.extractRoutes!(router.split("\n"), [], "config/routes.rb")),
      file("app/controllers/concerns/verify_concern.rb", [concern]),
      file("app/controllers/hooks/home_controller.rb", [{ ...cls("Hooks::HomeController", "ApplicationController", [["valid_token?", 6]]), implements: ["VerifyConcern"] } as ClassInfo]),
      file("app/controllers/hooks/away_controller.rb", [{ ...cls("Hooks::AwayController", "ApplicationController", [["valid_token?", 6]]), implements: ["VerifyConcern"] } as ClassInfo]),
      // Defines no hook: the concern's own method is what runs.
      file("app/controllers/hooks/friendly_controller.rb", [{ ...cls("Hooks::FriendlyController", "ApplicationController", []), implements: ["VerifyConcern"] } as ClassInfo]),
    ];
    const importIndex = buildImportIndex(out);
    const ctx = { importIndex, classes: buildClassIndex(out, importIndex), resolveModule: () => null, fileOf: (p: string) => out.find((a) => a.filePath === p) } as ProjectContext;
    reconcileProjectRoutes(out, ctx, [railsRouteAnchor]);
    const calls = (path: string) => out.flatMap((a) => a.routes).find((r) => r.path === path)!.calls.map((c) => c.name);
    expect(calls("/hooks/home")).toEqual(["Hooks::HomeController.valid_token?", "render"]);
    expect(calls("/hooks/away")).toEqual(["Hooks::AwayController.valid_token?", "render"]);
    expect(calls("/hooks/friendly")).toEqual(["valid_token?", "render"]);
  });
});
