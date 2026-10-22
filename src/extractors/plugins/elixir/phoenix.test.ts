import { describe, it, expect } from "vitest";
import { elixirSpec } from "./index.js";
import { elixirRequestSchema } from "./request-schema.js";
import { extractElixirRequestAccess } from "./phoenix.js";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";

const lines = (src: string) => src.split("\n");
const routes = (src: string): RouteInfo[] => elixirSpec.extractRoutes!(lines(src), [], "lib/app_web/router.ex", []);
const sig = (r: RouteInfo) => `${r.httpMethod} ${r.path} -> ${r.handler}`;

/** Functions → classes → postProcessClasses, as regex-extractor.ts runs them. */
function classesOf(src: string): ClassInfo[] {
  const ls = lines(src);
  const fns = extractFunctionsWithSpec(ls, elixirSpec);
  const classes = elixirSpec.extractClasses!(ls, fns);
  return elixirSpec.postProcessClasses!(ls, classes);
}

const ROUTER = `
defmodule AppWeb.Router do
  use Phoenix.Router

  pipeline :api do
    plug :accepts, ["json"]
    plug :fetch_session
  end

  pipeline :auth do
    plug AppWeb.Auth.Pipeline
    plug :require_authenticated_user
  end

  pipeline :admin do
    plug Guardian.Plug.EnsureAuthenticated
    plug :ensure_admin_role
  end

  scope "/api", AppWeb do
    pipe_through :api

    get "/health", HealthController, :show
  end

  scope "/api", AppWeb do
    pipe_through [:api, :auth]

    resources "/players", PlayerController, only: [:index, :show, :create]
    resources "/games", GameController, except: [:new, :edit] do
      resources "/comments", CommentController, only: [:index]
    end
    live "/dashboard", DashboardLive, :index
  end

  scope "/admin", AppWeb.Admin do
    pipe_through [:api, :admin]
    get "/stats", StatsController, :index
  end
end
`;

describe("Phoenix router — pipelines and pipe_through", () => {
  const out = routes(ROUTER);

  it("keeps plumbing plugs as middleware and none as a guard", () => {
    const health = out.find((r) => r.path === "/api/health")!;
    expect(health.auth).toBeUndefined();
    expect(health.middleware).toEqual([':accepts, ["json"]', ":fetch_session"]);
  });

  it("inherits the auth pipeline's guard plugs on every route of the scope", () => {
    const players = out.find((r) => r.handler === "PlayerController.index")!;
    expect(players.auth).toEqual({
      policies: ["AppWeb.Auth.Pipeline", "require_authenticated_user"],
      roles: [],
      schemes: [],
      anonymous: false,
      inherited: true,
    });
    expect(players.middleware).toEqual([':accepts, ["json"]', ":fetch_session", "AppWeb.Auth.Pipeline", ":require_authenticated_user"]);
  });

  it("treats Guardian plugs as schemes", () => {
    const stats = out.find((r) => r.path === "/admin/stats")!;
    expect(stats.auth).toMatchObject({ schemes: ["Guardian.Plug.EnsureAuthenticated"], policies: ["ensure_admin_role"] });
  });

  it("names an unknown pipeline as middleware rather than guessing", () => {
    const out2 = routes(`scope "/x" do\n  pipe_through :browser\n  get "/a", ACtl, :a\nend`);
    expect(out2[0]!.middleware).toEqual(["pipe_through :browser"]);
    expect(out2[0]!.auth).toBeUndefined();
  });
});

describe("Phoenix router — resources expansion", () => {
  const out = routes(ROUTER);

  it("expands `resources` with only:/except: and nests a do-block under /:parent_id", () => {
    expect(out.filter((r) => r.handler?.startsWith("PlayerController")).map(sig)).toEqual([
      "GET /api/players -> PlayerController.index",
      "POST /api/players -> PlayerController.create",
      "GET /api/players/:id -> PlayerController.show",
    ]);
    expect(out.filter((r) => r.handler?.startsWith("GameController")).map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/games", "POST /api/games", "GET /api/games/:id", "PUT /api/games/:id", "DELETE /api/games/:id",
    ]);
    expect(out.filter((r) => r.handler?.startsWith("CommentController")).map(sig)).toEqual([
      "GET /api/games/:game_id/comments -> CommentController.index",
    ]);
  });

  it("keeps live routes as frontend routes with the action", () => {
    const live = out.find((r) => r.kind === "frontend")!;
    expect(sig(live)).toBe("null /api/dashboard -> DashboardLive.index");
  });

  it("does not let a nested resources block leak its prefix past its end", () => {
    const stats = out.find((r) => r.path === "/admin/stats");
    expect(stats).toBeDefined();
  });
});

describe("Phoenix router — call form and wrapped statements", () => {
  const WRAPPED = `
defmodule LeagueWeb.Router do
  use LeagueWeb, :router

  pipeline :club_api do
    plug(:accepts, ["json"])
    plug(LeagueWeb.Plugs.AuthorizeClubAPI)
  end

  scope "/api/clubs" do
    scope "/v1", LeagueWeb.Clubs.Controllers, assigns: %{clubs_api: true} do
      pipe_through([:club_api])
      get("/kits", Kits, :index)
      put("/kits/:id", Kits, :update)
      get("/openapi", OpenApiSpex.Plug.RenderSpec, [])
    end

    scope "/:club/fixtures", LeagueWeb.Api.Internal,
      private: %{allow_shared: true} do
      get "/:fixture_id/tickets", FixturesController, :tickets
    end

    post "/:club/scouting/next-with-agent",
         ScoutingController,
         :next_with_agent
  end
end`;
  it("reads parenthesized macros, joins a wrapped scope's options and a wrapped route onto their first line", () => {
    const out = routes(WRAPPED);
    expect(out.map((r) => `${sig(r)} @${r.line}`)).toEqual([
      "GET /api/clubs/v1/kits -> Kits.index @13",
      "PUT /api/clubs/v1/kits/:id -> Kits.update @14",
      "GET /api/clubs/v1/openapi -> OpenApiSpex.Plug.RenderSpec @15",
      "GET /api/clubs/:club/fixtures/:fixture_id/tickets -> FixturesController.tickets @20",
      "POST /api/clubs/:club/scouting/next-with-agent -> ScoutingController.next_with_agent @23",
    ]);
    expect(out[0]!.middleware.join(" ")).toContain("accepts");
  });
});

describe("Phoenix controller — pattern-matched params", () => {
  const CTL = `
defmodule AppWeb.PlayerController do
  use Phoenix.Controller

  def index(conn, params) do
    page = conn.query_params["page"]
    json(conn, [])
  end

  def show(conn, %{"id" => id}) do
    json(conn, %{id: id})
  end

  def create(conn, %{"player" => player_params, "notify" => notify}) do
    [client] = get_req_header(conn, "x-client-id")
    json(conn, %{})
  end

  def update(conn, %{"id" => id, "player" => attrs} = params) do
    json(conn, %{})
  end
end
`;
  const cls = classesOf(CTL)[0]!;
  const method = (name: string) => cls.methods.find((m) => m.name === name)!;

  it("keeps a named params map, drops an unnamed pattern (its keys are the params), never fragments", () => {
    expect(method("show").params.map((p) => p.name)).toEqual(["conn"]);
    expect(method("update").params.map((p) => p.name)).toEqual(["conn", "params"]);
    expect(method("index").params.map((p) => p.name)).toEqual(["conn", "params"]);
  });

  it("binds `id` to the route, create keys to the body, and read keys to the query", () => {
    expect(method("show").requestAccess).toEqual([{ name: "id", type: null, binding: "route" }]);
    expect(method("create").requestAccess).toEqual([
      { name: "player", type: null, binding: "body" },
      { name: "notify", type: null, binding: "body" },
      { name: "x-client-id", type: null, binding: "header" },
    ]);
    expect(method("update").requestAccess).toEqual([
      { name: "id", type: null, binding: "route" },
      { name: "player", type: null, binding: "body" },
    ]);
    expect(method("index").requestAccess).toEqual([{ name: "page", type: null, binding: "query" }]);
  });

  it("binds `conn` to services via the schema hook", () => {
    expect(elixirRequestSchema.bindParam!({ name: "conn", type: null, defaultValue: null }, {} as RouteInfo)).toBe("services");
    expect(elixirRequestSchema.bindParam!({ name: "params", type: null, defaultValue: null }, {} as RouteInfo)).toBeNull();
  });
});

describe("Ecto schema → properties + hooks", () => {
  const SCHEMA = `
defmodule App.Clubs.Player do
  use Ecto.Schema
  import Ecto.Changeset

  schema "players" do
    field :name, :string
    field :age, :integer
    field :tags, {:array, :string}, default: []
    field :role, Ecto.Enum, values: [:player, :admin]
    belongs_to :organization, App.Clubs.Organization
    embeds_one :address, App.Clubs.Address
    timestamps()
  end

  def changeset(player, attrs) do
    player
    |> cast(attrs, [:name, :age, :tags])
    |> validate_required([:name])
  end
end
`;
  const cls = classesOf(SCHEMA)[0]!;

  it("lists fields with their Ecto types and validate_required as isRequired", () => {
    expect(cls.properties.map((p) => [p.name, p.type, p.isRequired ?? false])).toEqual([
      ["name", ":string", true],
      ["age", ":integer", false],
      ["tags", "{:array, :string}", false],
      ["role", "Ecto.Enum", false],
      ["organization_id", ":id", false],
      ["address", "App.Clubs.Address", false],
      ["inserted_at", ":naive_datetime", false],
      ["updated_at", ":naive_datetime", false],
    ]);
  });

  it("reads the cast keys as the body the changeset accepts", () => {
    expect(cls.methods.find((m) => m.name === "changeset")!.requestAccess).toEqual([
      { name: "name", type: null, binding: "body" },
      { name: "age", type: null, binding: "body" },
      { name: "tags", type: null, binding: "body" },
    ]);
  });

  it("maps Ecto types to shapes", () => {
    expect(elixirRequestSchema.describeType(":integer")).toEqual({ kind: "scalar", schema: { type: "integer" } });
    expect(elixirRequestSchema.describeType(":utc_datetime")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(elixirRequestSchema.describeType("{:array, :string}")).toEqual({ kind: "array", element: ":string" });
    expect(elixirRequestSchema.describeType(":map")).toEqual({ kind: "any" });
    expect(elixirRequestSchema.describeType("App.Clubs.Address")).toEqual({ kind: "object", name: "Address" });
  });

  it("leaves a module without a schema block property-less", () => {
    expect(classesOf(`defmodule App.Clubs do\n  def list_players, do: []\nend`)[0]!.properties).toEqual([]);
  });
});

describe("extractElixirRequestAccess", () => {
  it("reads conn.* params and headers", () => {
    expect(extractElixirRequestAccess(lines(`
      q = conn.query_params["q"]
      body = conn.body_params["payload"]
      id = conn.path_params["id"]
      [tok] = get_req_header(conn, "authorization")
    `))).toEqual([
      { name: "q", type: null, binding: "query" },
      { name: "payload", type: null, binding: "body" },
      { name: "id", type: null, binding: "route" },
      { name: "authorization", type: null, binding: "header" },
    ]);
  });
});

describe("Ecto schemas as entities with associations", () => {
  it("marks a schema module as an ecto entity with its table and resolves association targets to modules", async () => {
    const { elixirSpec } = await import("./index.js");
    const src = `defmodule Plausible.Site do
  use Ecto.Schema
  alias Plausible.Goal
  alias Plausible.Teams.{Team, GuestMembership}

  schema "sites" do
    field :domain, :string
    belongs_to :team, Team
    has_many :guest_memberships, GuestMembership
    has_many :goals, Goal, preload_order: [desc: :id]
    many_to_many :tags, Tag, join_through: "sites_tags"
    timestamps()
  end
end`;
    const lines = src.split("\n");
    const classes = elixirSpec.postProcessClasses!(lines, elixirSpec.extractClasses!(lines, []));
    expect(classes[0]!.decorators).toEqual(expect.arrayContaining(["entity", "ecto", "table:sites"]));
    const rels = elixirSpec.extractEntityRelations!(lines, classes, elixirSpec.extractImports!(lines));
    expect(rels.map((r) => `${r.fromField} -> ${r.toEntity} (${r.cardinality})`)).toEqual([
      "team -> Plausible.Teams.Team (many-to-one)",
      "guest_memberships -> Plausible.Teams.GuestMembership (one-to-many)",
      "goals -> Plausible.Goal (one-to-many)",
      "tags -> Plausible.Tag (many-to-many)",
    ]);
    expect(rels[0]!.foreignKey).toBe("team_id");
    expect(rels[3]!.joinTable).toBe("sites_tags");
  });
});
