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
    "    abstract def find(id : Int64) : Order?",
    "  end",
    "",
    "  class OrderService < BaseService",
    "    include Comparable(OrderService)",
    "    property name : String = \"orders\"",
    "    getter? enabled : Bool = true",
    "    @cache : Hash(Int64, Order)",
    "",
    "    def initialize(@repo : Repo, mailer : Mailer)",
    "      @cache = {} of Int64 => Order",
    "    end",
    "",
    "    def close(id : Int64, *, force = false) : Order",
    "      order = @repo.find(id)",
    "      order.close!",
    "      notify order",
    "      Audit.log(order)",
    "    end",
    "",
    "    private def notify(order : Order)",
    "    end",
    "  end",
    "end",
  ].join("\n"));

  it("reads classes, modules, records, mixins and properties", () => {
    expect(a.classes.map((c) => [c.name, c.extends, c.implements, c.properties.map((p) => `${p.name}:${p.type}`)])).toEqual([
      ["Shop", null, [], []],
      ["Repo", null, [], []],
      ["OrderService", "BaseService", ["Comparable"], ["name:String", "enabled:Bool", "cache:Hash(Int64, Order)", "repo:Repo"]],
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
    expect(close.returnType).toBe("Order");
    expect(close.calls.map((c) => c.name)).toEqual(["repo.find", "order.close!", "Audit.log"]);
    expect(fn(a, "find")!.returnType).toBe("Order?");
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
      'get "/orders/:id" do |env|',
      '  Order.find!(env.params.url["id"]).to_json',
      "end",
      'post "/orders" do |env|',
      "  create_order(env)",
      "end",
      "before_all do |env|",
      "  authenticate(env)",
      "end",
      "Kemal.run",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /orders/{id} [Order.find!]",
      "POST /orders [create_order]",
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
      '    resources "/posts", PostController, only: [:index, :show]',
      "  end",
      "end",
    ].join("\n"), "config/routes.cr");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET / -> HomeController.index",
      "GET /api/posts -> PostController.index",
      "GET /api/posts/{id} -> PostController.show",
    ]);
  });

  it("reads Lucky actions, explicit and inferred", () => {
    const a = analyze([
      "class Api::Orders::Show < ApiAction",
      '  get "/api/orders/:order_id" do',
      "    json OrderSerializer.new(OrderQuery.find(order_id))",
      "  end",
      "end",
      "class Projects::Tasks::Index < BrowserAction",
      "  nested_route do",
      "    html IndexPage, tasks: TaskQuery.new",
      "  end",
      "end",
      "class Users::Update < BrowserAction",
      "  route do",
      "    redirect Users::Show",
      "  end",
      "end",
    ].join("\n"), "src/actions/orders.cr");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual([
      "GET /api/orders/{order_id}",
      "GET /projects/{project_id}/tasks",
      "PUT /users/{user_id}",
    ]);
  });

  it("reads Athena and Spider-Gazelle annotations and Marten paths", () => {
    const a = analyze([
      '@[ARTA::Route("/api")]',
      "class UserController < ATH::Controller",
      '  @[ARTA::Get("/users/{id}")]',
      "  def user(id : Int64) : User",
      "  end",
      "end",
      "class Orders < Application",
      '  base "/orders"',
      '  @[AC::Route::POST("/:id/close")]',
      "  def close(id : Int64)",
      "  end",
      "end",
      "Marten.routes.draw do",
      '  path "/articles/<pk:int>", ArticleDetailHandler, name: "article_detail"',
      '  path "/blog", Blog::ROUTES, name: "blog"',
      "end",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /api/users/{id} -> UserController.user",
      "POST /orders/{id}/close -> Orders.close",
      "null /articles/{pk} -> ArticleDetailHandler",
    ]);
  });
});

describe("Crystal data access", () => {
  it("reads Avram queries, HTTP calls and SQL in heredocs — never a plain class's methods", () => {
    const a = analyze([
      "def load(id)",
      "  order = Order.find!(id)",
      "  order.save",
      "  UserQuery.new.email(\"x\").first",
      "  SaveUser.create(params)",
      "  Address.create(\"a@b.c\")",
      "  HTTP::Client.get(\"https://crm.example.com/customers/#{id}\")",
      "  db.exec <<-SQL",
      "    UPDATE orders SET closed = true",
      "    WHERE id = #{id}",
      "  SQL",
      "  db.query(\"SELECT id FROM customers\")",
      "end",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}${d.access ? ` ${d.access}` : ""}`)).toEqual([
      "database UserQuery.new User read",
      "database SaveUser.create User write",
      "api-call GET https://crm.example.com/customers/{id}",
      "database UPDATE orders write",
      "database SELECT customers read",
    ]);
    // The heredoc's SQL is no code.
    expect(fn(a, "load")!.calls.map((c) => c.name)).not.toContain("SET");
  });

  it("joins model queries project-wide, against the models the project declares", () => {
    const models = analyze("class Order < Granite::Base\n  column total : Float64\nend\n", "src/models/order.cr");
    const app = analyze([
      'post "/orders/:id/close" do |env|',
      '  order = Order.find!(env.params.url["id"])',
      "  order.save",
      "end",
      "def close(id)",
      "  order = Order.find!(id)",
      "  order.save",
      "  Address.create(\"a@b.c\")",
      "end",
    ].join("\n"));
    pluginFor("crystal")!.entities!.reconcileProject([models, app]);
    expect(app.dataSources.map((d) => `${d.name} ${d.access}@${d.line}`)).toEqual([
      "Order.find! read@2", "Order.save write@3", "Order.find! read@6", "Order.save write@7",
    ]);
  });

  it("reads Granite, Avram and Jennifer models", () => {
    const a = analyze([
      "class Order < Granite::Base",
      "  connection pg",
      "  table orders",
      "  column id : Int64, primary: true",
      "  column total : Float64",
      "  belongs_to customer : Customer",
      "  has_many :line_items",
      "end",
      "class User < BaseModel",
      "  table do",
      "    column email : String",
      "    has_many posts : Post",
      "  end",
      "end",
      "class Tag < Jennifer::Model::Base",
      "  mapping(",
      "    id: Primary32,",
      "    name: String?",
      "  )",
      "  has_and_belongs_to_many :posts, Post",
      "end",
    ].join("\n"), "src/models.cr");
    const entities = a.classes.filter((c) => c.decorators.includes("entity"));
    expect(entities.map((c) => [c.name, c.decorators.find((d) => d.startsWith("table:")), c.properties.map((p) => p.name)])).toEqual([
      ["Order", "table:orders", ["id", "total"]],
      ["User", "table:users", ["email"]],
      ["Tag", undefined, ["id", "name"]],
    ]);
    expect(a.entityRelations?.map((r) => `${r.fromEntity}.${r.fromField} ${r.cardinality} ${r.toEntity} ${r.confidence}`)).toEqual([
      "Order.customer many-to-one Customer EXTRACTED",
      "Order.line_items one-to-many LineItem INFERRED",
      "User.posts one-to-many Post EXTRACTED",
      "Tag.posts many-to-many Post EXTRACTED",
    ]);
  });
});
