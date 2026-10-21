import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";
import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";

/** Run the spec's route extractor over a Ruby snippet (no controller classes). */
function routes(src: string): RouteInfo[] {
  return rubySpec.extractRoutes?.(src.split("\n"), []) ?? [];
}

const draw = (body: string) => `Rails.application.routes.draw do\n${body}\nend`;
const sig = (r: RouteInfo) => `${r.httpMethod} ${r.path} -> ${r.handler}`;

describe("rubySpec.extractRoutes — router gating", () => {
  it("extracts verb routes from a real router file", () => {
    const out = routes(draw(`  get 'login' => 'session#login'\n  post 'logout' => 'session#logout'`));
    expect(out.map(sig)).toEqual(
      expect.arrayContaining(["GET /login -> SessionController#login", "POST /logout -> SessionController#logout"]),
    );
  });

  it("ignores verb-shaped calls in NON-router files (Cucumber steps, request specs)", () => {
    // Regression guard: these `get`/`delete` calls are HTTP requests, not routes.
    const cucumber = `
      When(/^I fetch duties$/) do
        get "/duties.xml?referee_id=#{referee_id}&start_date=#{start_date}"
      end
      When(/^I delete a duty$/) do
        delete "/duties/#{duty_id}.xml"
      end
    `;
    expect(routes(cucumber)).toHaveLength(0);
  });

  it("also gates `resources` declarations to router files", () => {
    expect(routes(`resources :duties`)).toHaveLength(0); // no routes.draw → not a router
  });
});

describe("rubySpec.extractRoutes — resources expansion", () => {
  it("expands `resources :duties` into the full RESTful route set", () => {
    const out = routes(draw(`  resources :duties`)).map(sig);
    expect(out).toEqual(
      expect.arrayContaining([
        "GET /duties -> DutiesController#index",
        "GET /duties/:id -> DutiesController#show",
        "GET /duties/new -> DutiesController#new",
        "GET /duties/:id/edit -> DutiesController#edit",
        "POST /duties -> DutiesController#create",
        "PUT /duties/:id -> DutiesController#update",
        "DELETE /duties/:id -> DutiesController#destroy",
      ]),
    );
    // No more null-method placeholder entries.
    expect(out.some((s) => s.startsWith("null "))).toBe(false);
  });

  it("applies the enclosing namespace prefix to member paths", () => {
    const out = routes(draw(`  namespace :staff do\n    resources :duties\n  end`)).map(sig);
    expect(out).toEqual(
      expect.arrayContaining([
        "GET /staff/duties -> Staff::DutiesController#index",
        "DELETE /staff/duties/:id -> Staff::DutiesController#destroy",
        "PUT /staff/duties/:id -> Staff::DutiesController#update",
      ]),
    );
  });

  it("qualifies a namespaced verb route's handler with the namespace module", () => {
    // `namespace :staff` puts its controllers in `Staff::` — the class
    // app/controllers/staff/events_controller.rb defines. A bare
    // `EventsController#destroy` would name the top-level twin instead.
    const out = routes(
      draw(`  namespace :staff do\n    delete 'events/:id' => 'events#destroy'\n    get 'duties/get_conflicts_on_duties'\n  end`),
    ).map(sig);
    expect(out).toEqual([
      "DELETE /staff/events/:id -> Staff::EventsController#destroy",
      "GET /staff/duties/get_conflicts_on_duties -> Staff::DutiesController#get_conflicts_on_duties",
    ]);
  });

  it("maps a directory in the controller token to a module (`admin/players#index`)", () => {
    const out = routes(draw(`  get 'dashboard' => 'admin/players#index'`)).map(sig);
    expect(out).toEqual(["GET /dashboard -> Admin::PlayersController#index"]);
  });

  it("hangs `on: :collection` / `on: :member` routes off the enclosing resource", () => {
    const out = routes(
      draw(
        `  resources :children, only: [:index], controller: 'children' do\n` +
          `    get 'presence', on: :collection\n` +
          `    post 'archive', on: :member\n` +
          `  end`,
      ),
    ).map(sig);
    expect(out).toEqual([
      "GET /children -> ChildrenController#index",
      "GET /children/presence -> ChildrenController#presence",
      "POST /children/:id/archive -> ChildrenController#archive",
    ]);
  });

  it("serves `collection do` / `member do` blocks off the resource, not off its nested `/:x_id` prefix", () => {
    const out = routes(
      draw(
        `  resources :players, only: [:index] do\n` +
          `    collection do\n      get :search\n      post :filter\n    end\n` +
          `    member do\n      post :transfer\n    end\n` +
          `    resources :injuries, only: [:index]\n` +
          `  end`,
      ),
    ).map(sig);
    expect(out).toEqual([
      "GET /players -> PlayersController#index",
      "GET /players/search -> PlayersController#search",
      "POST /players/filter -> PlayersController#filter",
      "POST /players/:id/transfer -> PlayersController#transfer",
      "GET /players/:player_id/injuries -> InjuriesController#index",
    ]);
  });

  it("maps a canonical action in a collection scope onto the collection path itself", () => {
    const out = routes(
      draw(`  resources :squad_members, only: [:create], param: :club_id do\n    collection do\n      delete :destroy\n      patch :update\n    end\n  end`),
    ).map(sig);
    expect(out).toEqual([
      "POST /squad_members -> SquadMembersController#create",
      "DELETE /squad_members -> SquadMembersController#destroy",
      "PATCH /squad_members -> SquadMembersController#update",
    ]);
  });

  it("reads `%i[…]` filters, a singular resource's member and an explicit `action:` on a path", () => {
    const out = routes(
      draw(
        `  resources :garages, only: [:show] do\n` +
          `    resource :inspection, only: %i[create destroy], controller: 'inspection' do\n      get :token, on: :member\n    end\n` +
          `    get 'preview/:token', action: :preview_status\n` +
          `  end`,
      ),
    ).map(sig);
    expect(out).toEqual([
      "GET /garages/:id -> GaragesController#show",
      "POST /garages/:garage_id/inspection -> InspectionController#create",
      "DELETE /garages/:garage_id/inspection -> InspectionController#destroy",
      "GET /garages/:garage_id/inspection/token -> InspectionController#token",
      "GET /garages/:garage_id/preview/:token -> GaragesController#preview_status",
    ]);
  });

  it("nests a resources block's children under one member of the parent", () => {
    const out = routes(
      draw(`  resources :referees, only: [:index] do\n    resources :contact_informations, only: [:index, :create]\n  end`),
    ).map(sig);
    expect(out).toEqual([
      "GET /referees -> RefereesController#index",
      "GET /referees/:referee_id/contact_informations -> ContactInformationsController#index",
      "POST /referees/:referee_id/contact_informations -> ContactInformationsController#create",
    ]);
  });

  it("honors `only:` and `except:` filters", () => {
    const only = routes(draw(`  resources :photos, only: [:index, :show]`)).map((r) => r.httpMethod + " " + r.path);
    expect(only.sort()).toEqual(["GET /photos", "GET /photos/:id"]);

    const except = routes(draw(`  resources :balls, except: [:destroy]`)).map(sig);
    expect(except.some((s) => s.startsWith("DELETE "))).toBe(false);
    expect(except).toEqual(expect.arrayContaining(["GET /balls/:id -> BallsController#show"]));
  });

  it("handles multiple resources on one line", () => {
    const out = routes(draw(`  resources :foos, :bars`)).map((r) => r.path);
    expect(out).toEqual(expect.arrayContaining(["/foos", "/foos/:id", "/bars", "/bars/:id"]));
  });

  it("expands a singular `resource` without index or :id, to the plural controller", () => {
    const out = routes(draw(`  resource :profile`)).map(sig);
    expect(out).toEqual(
      expect.arrayContaining([
        "GET /profile -> ProfilesController#show",
        "PUT /profile -> ProfilesController#update",
        "DELETE /profile -> ProfilesController#destroy",
      ]),
    );
    expect(out.some((s) => s.includes(":id"))).toBe(false);
    expect(out.some((s) => s.endsWith("#index"))).toBe(false);
  });
});

describe("rubySpec.extractRoutes — controller convention", () => {
  const cls = (name: string, line: number, endLine: number, methods: string[]): ClassInfo => ({
    name,
    extends: null,
    implements: [],
    decorators: [],
    properties: [],
    isExported: true,
    line,
    endLine,
    methods: methods.map((m, i) => ({
      name: m,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: false,
      decorators: [],
      calls: [],
      line: line + 1 + i,
      endLine: line + 1 + i,
    })),
  });

  it("prefixes a controller declared inside `module X` with the module's path and name", () => {
    // app/controllers/staff/duties_controller.rb — the module is captured
    // as a class entry whose line range encloses the controller's. Without the
    // prefix the route collides with the top-level DutiesController's.
    const src = `module Staff\n  class DutiesController < Controller\n    def index\n    end\n    def get_conflicts_on_duties\n    end\n  end\nend`;
    const classes = [cls("Staff", 1, 8, ["index", "get_conflicts_on_duties"]), cls("DutiesController", 2, 7, ["index", "get_conflicts_on_duties"])];
    const out = (rubySpec.extractRoutes?.(src.split("\n"), classes) ?? []).map(sig);
    expect(out).toEqual([
      "GET /staff/duties -> Staff::DutiesController#index",
      "GET /staff/duties/get_conflicts_on_duties -> Staff::DutiesController#get_conflicts_on_duties",
    ]);
  });

  it("reads the namespace off a `class Admin::PlayersController` name", () => {
    const src = `class Admin::PlayersController < ApplicationController\n  def index\n  end\nend`;
    const out = (rubySpec.extractRoutes?.(src.split("\n"), [cls("Admin::PlayersController", 1, 4, ["index"])]) ?? []).map(sig);
    expect(out).toEqual(["GET /admin/players -> Admin::PlayersController#index"]);
  });

  it("leaves a top-level controller unprefixed", () => {
    const src = `class PlayersController < ApplicationController\n  def index\n  end\nend`;
    const out = (rubySpec.extractRoutes?.(src.split("\n"), [cls("PlayersController", 1, 4, ["index"])]) ?? []).map(sig);
    expect(out).toEqual(["GET /players -> PlayersController#index"]);
  });
});

describe("routes.rb: root, symbol member routes, singular plural resources", () => {
  it("reads root inside a namespace, `post :seed, on: :member` and keeps an already-plural singular resource", async () => {
    const { rubySpec } = await import("./index.js");
    const lines = `Rails.application.routes.draw do
  namespace :super_admin do
    root to: 'dashboard#index'
    resource :player_diagnostics, only: [:show]
    resources :players, only: [:show] do
      post :seed, on: :member
      delete :avatar, on: :member, action: :destroy_avatar
      get 'presence', :on => :collection
    end
  end
end`.split("\n");
    const routes = rubySpec.extractRoutes!(lines, [], "config/routes.rb");
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "GET /super_admin SuperAdmin::DashboardController#index",
      "GET /super_admin/player_diagnostics SuperAdmin::PlayerDiagnosticsController#show",
      "GET /super_admin/players/:id SuperAdmin::PlayersController#show",
      "POST /super_admin/players/:id/seed SuperAdmin::PlayersController#seed",
      "DELETE /super_admin/players/:id/avatar SuperAdmin::PlayersController#destroy_avatar",
      "GET /super_admin/players/presence SuperAdmin::PlayersController#presence",
    ]);
  });
});

describe("routes.rb: controller modules a scope or a resources option names", () => {
  it("puts controllers under `scope module:` and `resources …, module:` without changing the path", () => {
    const out = routes(
      draw(`  namespace :api do
    resources :clubs, only: [:show] do
      scope module: :clubs do
        resources :labels, only: [:index]
        resources :inboxes, only: [:index], module: :assignment_policies
      end
    end
    scope module: 'profile' do
      resource :profile, only: [:show]
    end
  end`),
    ).map(sig);
    expect(out).toEqual([
      "GET /api/clubs/:id -> Api::ClubsController#show",
      "GET /api/clubs/:club_id/labels -> Api::Clubs::LabelsController#index",
      "GET /api/clubs/:club_id/inboxes -> Api::Clubs::AssignmentPolicies::InboxesController#index",
      "GET /api/profile -> Api::Profile::ProfilesController#show",
    ]);
  });
});

describe("routes.rb: redirects and symbol controllers", () => {
  it("leaves a redirect without a controller and reads `controller: :name`", () => {
    const out = routes(
      draw(`  get '/garage/install', to: redirect(status: 302) { |_p, req| "/app/garage" }\n  resources :clubs, only: [] do\n    resource :stats, only: [:show], controller: :club_stats\n  end`),
    ).map(sig);
    expect(out).toEqual(["GET /garage/install -> null", "GET /clubs/:club_id/stats -> ClubStatsController#show"]);
  });
});
