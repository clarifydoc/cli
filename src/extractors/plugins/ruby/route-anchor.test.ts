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
        // The plugin's guesses from action names: `show` is declared by the router, `export` is not.
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
        "GET /api/labels/export @ app/controllers/api/labels_controller.rb:12",
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
