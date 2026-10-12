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
        get "/duties.xml?employee_id=#{employee_id}&start_date=#{start_date}"
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
    const out = routes(draw(`  namespace :personale do\n    resources :duties\n  end`)).map(sig);
    expect(out).toEqual(
      expect.arrayContaining([
        "GET /personale/duties -> Personale::DutiesController#index",
        "DELETE /personale/duties/:id -> Personale::DutiesController#destroy",
        "PUT /personale/duties/:id -> Personale::DutiesController#update",
      ]),
    );
  });

  it("qualifies a namespaced verb route's handler with the namespace module", () => {
    // `namespace :personale` puts its controllers in `Personale::` — the class
    // app/controllers/personale/events_controller.rb defines. A bare
    // `EventsController#destroy` would name the top-level twin instead.
    const out = routes(
      draw(`  namespace :personale do\n    delete 'events/:id' => 'events#destroy'\n    get 'duties/get_conflicts_on_duties'\n  end`),
    ).map(sig);
    expect(out).toEqual([
      "DELETE /personale/events/:id -> Personale::EventsController#destroy",
      "GET /personale/duties/get_conflicts_on_duties -> Personale::DutiesController#get_conflicts_on_duties",
    ]);
  });

  it("maps a directory in the controller token to a module (`admin/users#index`)", () => {
    const out = routes(draw(`  get 'dashboard' => 'admin/users#index'`)).map(sig);
    expect(out).toEqual(["GET /dashboard -> Admin::UsersController#index"]);
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

  it("nests a resources block's children under one member of the parent", () => {
    const out = routes(
      draw(`  resources :employees, only: [:index] do\n    resources :contact_informations, only: [:index, :create]\n  end`),
    ).map(sig);
    expect(out).toEqual([
      "GET /employees -> EmployeesController#index",
      "GET /employees/:employee_id/contact_informations -> ContactInformationsController#index",
      "POST /employees/:employee_id/contact_informations -> ContactInformationsController#create",
    ]);
  });

  it("honors `only:` and `except:` filters", () => {
    const only = routes(draw(`  resources :photos, only: [:index, :show]`)).map((r) => r.httpMethod + " " + r.path);
    expect(only.sort()).toEqual(["GET /photos", "GET /photos/:id"]);

    const except = routes(draw(`  resources :widgets, except: [:destroy]`)).map(sig);
    expect(except.some((s) => s.startsWith("DELETE "))).toBe(false);
    expect(except).toEqual(expect.arrayContaining(["GET /widgets/:id -> WidgetsController#show"]));
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
    // app/controllers/personale/duties_controller.rb — the module is captured
    // as a class entry whose line range encloses the controller's. Without the
    // prefix the route collides with the top-level DutiesController's.
    const src = `module Personale\n  class DutiesController < Controller\n    def index\n    end\n    def get_conflicts_on_duties\n    end\n  end\nend`;
    const classes = [cls("Personale", 1, 8, ["index", "get_conflicts_on_duties"]), cls("DutiesController", 2, 7, ["index", "get_conflicts_on_duties"])];
    const out = (rubySpec.extractRoutes?.(src.split("\n"), classes) ?? []).map(sig);
    expect(out).toEqual([
      "GET /personale/duties -> Personale::DutiesController#index",
      "GET /personale/duties/get_conflicts_on_duties -> Personale::DutiesController#get_conflicts_on_duties",
    ]);
  });

  it("reads the namespace off a `class Admin::UsersController` name", () => {
    const src = `class Admin::UsersController < ApplicationController\n  def index\n  end\nend`;
    const out = (rubySpec.extractRoutes?.(src.split("\n"), [cls("Admin::UsersController", 1, 4, ["index"])]) ?? []).map(sig);
    expect(out).toEqual(["GET /admin/users -> Admin::UsersController#index"]);
  });

  it("leaves a top-level controller unprefixed", () => {
    const src = `class UsersController < ApplicationController\n  def index\n  end\nend`;
    const out = (rubySpec.extractRoutes?.(src.split("\n"), [cls("UsersController", 1, 4, ["index"])]) ?? []).map(sig);
    expect(out).toEqual(["GET /users -> UsersController#index"]);
  });
});

describe("routes.rb: root, symbol member routes, singular plural resources", () => {
  it("reads root inside a namespace, `post :seed, on: :member` and keeps an already-plural singular resource", async () => {
    const { rubySpec } = await import("./index.js");
    const lines = `Rails.application.routes.draw do
  namespace :super_admin do
    root to: 'dashboard#index'
    resource :user_diagnostics, only: [:show]
    resources :users, only: [:show] do
      post :seed, on: :member
      delete :avatar, on: :member, action: :destroy_avatar
    end
  end
end`.split("\n");
    const routes = rubySpec.extractRoutes!(lines, [], "config/routes.rb");
    expect(routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual([
      "GET /super_admin SuperAdmin::DashboardController#index",
      "GET /super_admin/user_diagnostics SuperAdmin::UserDiagnosticsController#show",
      "GET /super_admin/users/:id SuperAdmin::UsersController#show",
      "POST /super_admin/users/:id/seed SuperAdmin::UsersController#seed",
      "DELETE /super_admin/users/:id/avatar SuperAdmin::UsersController#destroy_avatar",
    ]);
  });
});
