import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";
import type { RouteInfo } from "../../../types/analysis.js";

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
        "GET /personale/duties -> DutiesController#index",
        "DELETE /personale/duties/:id -> DutiesController#destroy",
        "PUT /personale/duties/:id -> DutiesController#update",
      ]),
    );
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
