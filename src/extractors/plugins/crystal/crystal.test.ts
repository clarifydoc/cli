import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/app.cr"): FileAnalysis {
  const pre = pluginFor("crystal")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "crystal");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fn = (a: FileAnalysis, name: string) => [...a.functions, ...a.classes.flatMap((c) => c.methods)].find((f) => f.name === name);

describe("Crystal functions and types", () => {
  const a = analyze([
    'require "./models/*"',
    'require "granite/adapter/pg"',
    "module Shop",
    "  record Money, cents : Int64, currency : String = \"EUR\"",
    "",
    "  abstract class Repo",
    "    abstract def find(id : Int64) : Car?",
    "  end",
    "",
    "  class CarService < BaseService",
    "    include Comparable(CarService)",
    "    property name : String = \"cars\"",
    "    getter? enabled : Bool = true",
    "    @cache : Hash(Int64, Car)",
    "",
    "    def initialize(@repo : Repo, mailer : Mailer)",
    "      @cache = {} of Int64 => Car",
    "    end",
    "",
    "    def close(id : Int64, *, force = false) : Car",
    "      car = @repo.find(id)",
    "      car.close!",
    "      notify car",
    "      Audit.log(car)",
    "    end",
    "",
    "    private def notify(car : Car)",
    "    end",
    "  end",
    "end",
  ].join("\n"));

  it("reads classes, modules, records, mixins and properties", () => {
    expect(a.classes.map((c) => [c.name, c.extends, c.implements, c.properties.map((p) => `${p.name}:${p.type}`)])).toEqual([
      ["Shop", null, [], []],
      ["Repo", null, [], []],
      ["CarService", "BaseService", ["Comparable"], ["name:String", "enabled:Bool", "cache:Hash(Int64, Car)", "repo:Repo"]],
      ["Money", null, [], ["cents:Int64", "currency:String"]],
    ]);
    expect(a.classes.find((c) => c.name === "Shop")!.methods).toEqual([]);
  });

  it("reads methods with typed params and return types", () => {
    const close = fn(a, "close")!;
    expect(close.params).toEqual([
      { name: "id", type: "Int64", defaultValue: null },
      { name: "force", type: null, defaultValue: "false" },
    ]);
    expect(close.returnType).toBe("Car");
    expect(close.calls.map((c) => c.name)).toEqual(["repo.find", "car.close!", "Audit.log"]);
    expect(fn(a, "find")!.returnType).toBe("Car?");
    expect(fn(a, "notify")!.isExported).toBe(false);
  });

  it("reads requires as imports", () => {
    expect(a.imports.map((i) => i.source)).toEqual(["./models/*", "granite/adapter/pg"]);
  });
});

describe("Crystal routes", () => {
  it("reads Kemal routes, and keeps their blocks out of the script's own calls", () => {
    const a = analyze([
      'require "kemal"',
      'get "/cars/:id" do |env|',
      '  Car.find!(env.params.url["id"]).to_json',
      "end",
      'post "/cars" do |env|',
      "  create_car(env)",
      "end",
      "before_all do |env|",
      "  authenticate(env)",
      "end",
      "Kemal.run",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /cars/{id} [Car.find!]",
      "POST /cars [create_car]",
    ]);
    expect(fn(a, "<setup>")!.calls.map((c) => c.name)).toEqual(["Kemal.run"]);
  });

  it("reads Amber routes and resources under a scope prefix", () => {
    const a = analyze([
      "Amber::Server.configure do",
      "  routes :web do",
      '    get "/", HomeController, :index',
      "  end",
      '  routes :api, "/api" do',
      '    resources "/games", GameController, only: [:index, :show]',
      "  end",
      "end",
    ].join("\n"), "config/routes.cr");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET / -> HomeController.index",
      "GET /api/games -> GameController.index",
      "GET /api/games/{id} -> GameController.show",
    ]);
  });

  it("reads Lucky actions, explicit and inferred", () => {
    const a = analyze([
      "class Api::Cars::Show < ApiAction",
      '  get "/api/cars/:car_id" do',
      "    json CarSerializer.new(CarQuery.find(car_id))",
      "  end",
      "end",
      "class Projects::Tasks::Index < BrowserAction",
      "  nested_route do",
      "    html IndexPage, tasks: TaskQuery.new",
      "  end",
      "end",
      "class Players::Update < BrowserAction",
      "  route do",
      "    redirect Players::Show",
      "  end",
      "end",
    ].join("\n"), "src/actions/cars.cr");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/cars/{car_id}",
      "GET /projects/{project_id}/tasks",
      "PUT /players/{player_id}",
    ]);
  });

  it("reads Athena and Spider-Gazelle annotations and Marten paths", () => {
    const a = analyze([
      '@[ARTA::Route("/api")]',
      "class PlayerController < ATH::Controller",
      '  @[ARTA::Get("/players/{id}")]',
      "  def player(id : Int64) : Player",
      "  end",
      "end",
      "class Cars < Application",
      '  base "/cars"',
      '  @[AC::Route::POST("/:id/close")]',
      "  def close(id : Int64)",
      "  end",
      "end",
      "Marten.routes.draw do",
      '  path "/reports/<pk:int>", ReportDetailHandler, name: "report_detail"',
      '  path "/blog", Blog::ROUTES, name: "blog"',
      "end",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /api/players/{id} -> PlayerController.player",
      "POST /cars/{id}/close -> Cars.close",
      "null /reports/{pk} -> ReportDetailHandler",
    ]);
  });
});

describe("Crystal data access", () => {
  it("reads Avram queries, HTTP calls and SQL in heredocs — never a plain class's methods", () => {
    const a = analyze([
      "def load(id)",
      "  car = Car.find!(id)",
      "  car.save",
      "  PlayerQuery.new.email(\"x\").first",
      "  SavePlayer.create(params)",
      "  Address.create(\"a@b.c\")",
      "  HTTP::Client.get(\"https://crm.example.com/drivers/#{id}\")",
      "  db.exec <<-SQL",
      "    UPDATE cars SET closed = true",
      "    WHERE id = #{id}",
      "  SQL",
      "  db.query(\"SELECT id FROM drivers\")",
      "end",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}${d.access ? ` ${d.access}` : ""}`)).toEqual([
      "database PlayerQuery.new Player read",
      "database SavePlayer.create Player write",
      "api-call GET https://crm.example.com/drivers/{id}",
      "database UPDATE cars write",
      "database SELECT drivers read",
    ]);
    // The heredoc's SQL is no code.
    expect(fn(a, "load")!.calls.map((c) => c.name)).not.toContain("SET");
  });

  it("joins model queries project-wide, against the models the project declares", () => {
    const models = analyze("class Car < Granite::Base\n  column total : Float64\nend\n", "src/models/car.cr");
    const app = analyze([
      'post "/cars/:id/close" do |env|',
      '  car = Car.find!(env.params.url["id"])',
      "  car.save",
      "end",
      "def close(id)",
      "  car = Car.find!(id)",
      "  car.save",
      "  Address.create(\"a@b.c\")",
      "end",
    ].join("\n"));
    pluginFor("crystal")!.entities!.reconcileProject([models, app]);
    expect(app.dataSources.map((d) => `${d.name} ${d.access}@${d.line}`)).toEqual([
      "Car.find! read@2", "Car.save write@3", "Car.find! read@6", "Car.save write@7",
    ]);
  });

  it("reads Granite, Avram and Jennifer models", () => {
    const a = analyze([
      "class Car < Granite::Base",
      "  connection pg",
      "  table cars",
      "  column id : Int64, primary: true",
      "  column total : Float64",
      "  belongs_to driver : Driver",
      "  has_many :car_parts",
      "end",
      "class Player < BaseModel",
      "  table do",
      "    column email : String",
      "    has_many games : Game",
      "  end",
      "end",
      "class Tag < Jennifer::Model::Base",
      "  mapping(",
      "    id: Primary32,",
      "    name: String?",
      "  )",
      "  has_and_belongs_to_many :games, Game",
      "end",
    ].join("\n"), "src/models.cr");
    const entities = a.classes.filter((c) => c.decorators.includes("entity"));
    expect(entities.map((c) => [c.name, c.decorators.find((d) => d.startsWith("table:")), c.properties.map((p) => p.name)])).toEqual([
      ["Car", "table:cars", ["id", "total"]],
      ["Player", "table:players", ["email"]],
      ["Tag", undefined, ["id", "name"]],
    ]);
    expect(a.entityRelations?.map((r) => `${r.fromEntity}.${r.fromField} ${r.cardinality} ${r.toEntity} ${r.confidence}`)).toEqual([
      "Car.driver many-to-one Driver EXTRACTED",
      "Car.car_parts one-to-many CarPart INFERRED",
      "Player.games one-to-many Game EXTRACTED",
      "Tag.games many-to-many Game EXTRACTED",
    ]);
  });
});
