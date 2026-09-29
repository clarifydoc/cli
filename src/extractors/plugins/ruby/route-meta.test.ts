import { describe, it, expect } from "vitest";
import { rubySpec } from "./index.js";
import { extractRubyRequestAccess } from "./route-meta.js";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { dedupeRoutes } from "../../../core/route-linker.js";
import type { RouteInfo } from "../../../types/analysis.js";

/** Run the full regex pipeline the way regex-extractor.ts does for one file. */
function analyze(src: string, filePath = "app/controllers/users_controller.rb"): { routes: RouteInfo[]; classes: ReturnType<NonNullable<typeof rubySpec.extractClasses>> } {
  const lines = src.split("\n");
  const fns = extractFunctionsWithSpec(lines, rubySpec);
  const classes = rubySpec.extractClasses!(lines, fns);
  const routes = rubySpec.extractRoutes!(lines, classes, filePath, fns);
  return { routes, classes };
}

const byHandler = (routes: RouteInfo[], handler: string) => routes.find((r) => r.handler === handler)!;

const CONTROLLER = `
class UsersController < ApplicationController
  before_action :authenticate_user!, except: [:index, :show]
  before_action :require_admin, only: [:destroy]
  before_action :set_user, only: [:show, :update, :destroy]
  skip_before_action :authenticate_user!, only: [:search]
  protect_from_forgery with: :exception

  def index
    render json: User.all
  end

  def show
    render json: @user
  end

  def create
    user = User.create!(user_params)
    render json: user, status: :created
  end

  def update
    @user.update!(params.require(:user).permit(:name, :email))
    head :no_content
  end

  def destroy
    authorize @user
    @user.destroy!
  end

  def search
    q = params[:q]
    token = request.headers["X-Api-Key"]
    render json: User.search(q)
  end

  private

  def set_user
    @user = User.find(params[:id])
  end

  def user_params
    params.require(:user).permit(:name, :email, roles: [])
  end
end
`;

describe("extractRubyRequestAccess", () => {
  it("reads strong params, path keys, query keys and headers", () => {
    const access = extractRubyRequestAccess(`
      user = User.find(params[:id])
      page = params.fetch(:page, 1)
      attrs = params.require(:user).permit(:name, :email, roles: [])
      key = request.headers["X-Api-Key"]
      raw = request.body.read
    `.split("\n"));
    expect(access).toEqual([
      { name: "user", type: null, binding: "body" },
      { name: "user.name", type: null, binding: "body" },
      { name: "user.email", type: null, binding: "body" },
      { name: "user.roles", type: null, binding: "body" },
      { name: "id", type: null, binding: "route" },
      { name: "page", type: null, binding: "query" },
      { name: "X-Api-Key", type: null, binding: "header" },
      { name: "body", type: null, binding: "body" },
    ]);
  });

  it("says nothing for a body that never touches the request", () => {
    expect(extractRubyRequestAccess(["  total = items.sum(&:price)"])).toEqual([]);
  });
});

describe("Rails controller routes — auth from filters", () => {
  const { routes } = analyze(CONTROLLER);

  it("inherits `before_action` guards, honouring except:/only: per action", () => {
    const create = byHandler(routes, "UsersController#create");
    expect(create.auth).toEqual({
      policies: ["authenticate_user!"],
      roles: [],
      schemes: ["devise"],
      anonymous: false,
      inherited: true,
    });
    expect(create.middleware).toEqual(["before_action :authenticate_user!"]);

    const destroy = byHandler(routes, "UsersController#destroy");
    expect(destroy.auth?.policies).toEqual(["authenticate_user!", "require_admin", "pundit"]);
    expect(destroy.auth?.inherited).toBe(false); // `authorize @user` is the action's own
    expect(destroy.middleware).toEqual([
      "before_action :set_user",
      "before_action :authenticate_user!",
      "before_action :require_admin",
      "authorize @user",
    ]);

    // `index` is in `except:` — no auth declared at all (unknown, not open).
    const index = byHandler(routes, "UsersController#index");
    expect(index.auth).toBeUndefined();
    expect(index.middleware).toEqual([]);
  });

  it("marks a `skip_before_action` of the auth filter anonymous", () => {
    const search = byHandler(routes, "UsersController#search");
    expect(search.auth).toMatchObject({ anonymous: true, policies: [] });
    expect(search.middleware).toEqual(["skip_before_action :authenticate_user!"]);
  });

  it("keeps a loader filter as middleware without making it a guard", () => {
    const show = byHandler(routes, "UsersController#show");
    expect(show.auth).toBeUndefined();
    expect(show.middleware).toEqual(["before_action :set_user"]);
  });
});

describe("Rails controller routes — params from the body", () => {
  const { routes } = analyze(CONTROLLER);

  it("binds an inline `params.require(...).permit(...)` to the body and `:id` to the route", () => {
    const update = byHandler(routes, "UsersController#update");
    expect(update.params).toEqual([
      { name: "user", type: null, binding: "body", inferred: true },
      { name: "user.name", type: null, binding: "body", inferred: true },
      { name: "user.email", type: null, binding: "body", inferred: true },
      { name: "id", type: null, binding: "route", inferred: true },
    ]);
  });

  it("follows strong params into the private helper the action calls", () => {
    const create = byHandler(routes, "UsersController#create");
    expect(create.params?.map((p) => `${p.binding}:${p.name}`)).toEqual([
      "body:user", "body:user.name", "body:user.email", "body:user.roles",
    ]);
  });

  it("binds query keys and headers", () => {
    const search = byHandler(routes, "UsersController#search");
    expect(search.params).toEqual([
      { name: "q", type: null, binding: "query", inferred: true },
      { name: "X-Api-Key", type: null, binding: "header", inferred: true },
    ]);
  });
});

describe("routes.rb + controller convention — dedupe keeps the annotated entry", () => {
  it("the controller entry (calls + auth + params) wins over the routes.rb twin", () => {
    const ctl = analyze(CONTROLLER);
    const router = analyze(
      `Rails.application.routes.draw do\n  resources :users\n  get "users/search", to: "users#search"\nend`,
      "config/routes.rb",
    );
    const all = [
      ...ctl.routes.map((r) => ({ ...r, filePath: "app/controllers/users_controller.rb", projectId: "root" })),
      ...router.routes.map((r) => ({ ...r, filePath: "config/routes.rb", projectId: "root" })),
    ];
    const kept = dedupeRoutes(all);
    const create = kept.find((r) => r.httpMethod === "POST" && r.path === "/users")!;
    expect(create.filePath).toBe("app/controllers/users_controller.rb");
    expect(create.auth?.schemes).toEqual(["devise"]);
    expect(create.params?.length).toBeGreaterThan(0);
    const search = kept.find((r) => r.path === "/users/search")!;
    expect(search.filePath).toBe("app/controllers/users_controller.rb");
    expect(search.auth?.anonymous).toBe(true);
    expect(kept.filter((r) => r.path === "/users/:id" && r.httpMethod === "GET")).toHaveLength(1);
  });

  it("a Devise `authenticate :admin_user do` block guards the routes inside it", () => {
    const { routes } = analyze(
      `Rails.application.routes.draw do\n  authenticate :admin_user do\n    resources :reports, only: [:index]\n  end\n  get "health", to: "health#show"\nend`,
      "config/routes.rb",
    );
    const reports = routes.find((r) => r.path === "/reports")!;
    expect(reports.auth).toEqual({ policies: ["authenticate :admin_user"], roles: [], schemes: ["devise"], anonymous: false, inherited: true });
    expect(routes.find((r) => r.path === "/health")!.auth).toBeUndefined();
  });
});

describe("CanCan / basic auth macros", () => {
  it("load_and_authorize_resource and http_basic_authenticate_with are inherited guards", () => {
    const { routes } = analyze(`
class ArticlesController < ApplicationController
  http_basic_authenticate_with name: "admin", password: "secret", only: :destroy
  load_and_authorize_resource

  def index
  end

  def destroy
  end
end
`);
    const index = byHandler(routes, "ArticlesController#index");
    expect(index.auth).toMatchObject({ policies: ["load_and_authorize_resource"], schemes: [] });
    const destroy = byHandler(routes, "ArticlesController#destroy");
    expect(destroy.auth).toMatchObject({ policies: ["http_basic_authenticate_with", "load_and_authorize_resource"], schemes: ["basic"] });
  });
});

describe("Sinatra block routes", () => {
  const SRC = `
require 'sinatra'
require 'json'

before '/admin/*' do
  halt 401 unless session[:user_id]
end

get '/users/:id' do
  user = User.find(params[:id])
  json user
end

post '/users' do
  data = JSON.parse(request.body.read)
  status 201
end

get '/admin/stats' do
  format = params['format']
  json stats(format)
end

get '/secret' do
  protected!
  "ok"
end
`;
  const { routes } = analyze(SRC, "app.rb");

  it("extracts verb blocks with path/query/body params", () => {
    expect(routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /users/:id", "POST /users", "GET /admin/stats", "GET /secret"]);
    expect(routes[0]!.params).toEqual([{ name: "id", type: null, binding: "route", inferred: true }]);
    expect(routes[1]!.params).toEqual([{ name: "body", type: null, binding: "body", inferred: true }]);
    expect(routes[2]!.params).toEqual([{ name: "format", type: null, binding: "query", inferred: true }]);
  });

  it("applies a path-filtered `before` guard only under its prefix, and `protected!` per route", () => {
    expect(routes[0]!.auth).toBeUndefined();
    expect(routes[2]!.auth).toMatchObject({ policies: ["halt 401 unless session[:user_id]"], inherited: true });
    expect(routes[3]!.auth).toMatchObject({ policies: ["protected!"], inherited: false });
  });

  it("does not read the DSL from a non-Sinatra file", () => {
    const spec = `
      describe "users" do
        get '/users' do
          expect(last_response).to be_ok
        end
      end
    `;
    expect(analyze(spec, "spec/users_spec.rb").routes).toEqual([]);
  });
});
