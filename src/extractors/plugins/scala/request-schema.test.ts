import { describe, it, expect } from "vitest";
import { extractFunctionsWithSpec } from "../shared/regex-base.js";
import { scalaSpec } from "./index.js";
import { extractPlayRoutes, isPlayRoutesFile } from "./routes.js";
import { extractScalaRequestAccess, scalaRequestSchema as h } from "./request-schema.js";

const classes = (src: string) => scalaSpec.extractClasses!(src.split("\n"), []);
const functions = (src: string) => extractFunctionsWithSpec(src.split("\n"), scalaSpec);

describe("Scala request-schema hooks", () => {
  it("classifies scalars, collections, maps, Option and unknown objects", () => {
    expect(h.unwrapNullable("Option[String]")).toEqual({ type: "String", nullable: true });
    expect(h.unwrapNullable("scala.Option[Seq[Item]]")).toEqual({ type: "Seq[Item]", nullable: true });
    expect(h.describeType("String")).toEqual({ kind: "scalar", schema: { type: "string" } });
    expect(h.describeType("Long")).toEqual({ kind: "scalar", schema: { type: "integer", format: "int64" } });
    expect(h.describeType("BigDecimal")).toEqual({ kind: "scalar", schema: { type: "number", format: "double" } });
    expect(h.describeType("java.time.Instant")).toEqual({ kind: "scalar", schema: { type: "string", format: "date-time" } });
    expect(h.describeType("LocalDate")).toEqual({ kind: "scalar", schema: { type: "string", format: "date" } });
    expect(h.describeType("java.util.UUID")).toEqual({ kind: "scalar", schema: { type: "string", format: "uuid" } });
    expect(h.describeType("Seq[Item]")).toEqual({ kind: "array", element: "Item" });
    expect(h.describeType("Vector[Seq[Int]]")).toEqual({ kind: "array", element: "Seq[Int]" });
    expect(h.describeType("Map[String, Item]")).toEqual({ kind: "map", value: "Item" });
    expect(h.describeType("JsValue")).toEqual({ kind: "any" });
    expect(h.describeType("Item")).toEqual({ kind: "object", name: "Item" });
  });

  it("reads JsonProperty names and ignore markers; required comes from the declaration", () => {
    const p = (decorators: string[], extra: Record<string, unknown> = {}) => ({
      name: "placedAt", type: "Instant", visibility: "public" as const, isStatic: false, isReadonly: true, decorators, ...extra,
    });
    expect(h.serializedName(p(['JsonProperty("placed_at")']))).toBe("placed_at");
    expect(h.serializedName(p([]))).toBe("placedAt");
    expect(h.isSerialized(p(["JsonIgnore"]))).toBe(false);
    expect(h.isSerialized(p([]))).toBe(true);
    expect(h.isRequired(p([], { isRequired: true }))).toBe(true);
    expect(h.isRequired(p([]))).toBe(false);
  });

  it("binds a Play Request to services and every other action parameter to the query string", () => {
    const route = { path: "/orders/:id", httpMethod: "PUT", kind: "api" as const, handler: "OrderController.update", calls: [], middleware: [], line: 1 };
    expect(h.bindParam!({ name: "request", type: "Request[AnyContent]", defaultValue: null }, route)).toBe("services");
    expect(h.bindParam!({ name: "request", type: "RequestHeader", defaultValue: null }, route)).toBe("services");
    expect(h.bindParam!({ name: "page", type: "Int", defaultValue: null }, route)).toBe("query");
  });
});

describe("Scala constructor parameters as properties", () => {
  it("reads a case class's fields with types, defaults, Option and inline annotations", () => {
    const found = classes(
      [
        "case class CreateOrder(",
        "    items: Seq[Item],",
        '    @JsonProperty("note_text") note: Option[String] = None,',
        "    priority: Int = 0,",
        ")(implicit ec: ExecutionContext)",
        "",
        "case class Item(sku: String, qty: Int)",
      ].join("\n"),
    );
    const order = found.find((c) => c.name === "CreateOrder")!;
    expect(order.properties.map((p) => [p.name, p.type, p.isRequired ?? false, p.decorators ?? []])).toEqual([
      ["items", "Seq[Item]", true, []],
      ["note", "Option[String]", false, ['JsonProperty("note_text")']],
      ["priority", "Int", false, []],
    ]);
    const item = found.find((c) => c.name === "Item")!;
    expect(item.properties.map((p) => [p.name, p.type, p.isRequired])).toEqual([["sku", "String", true], ["qty", "Int", true]]);
  });

  it("keeps only val/var parameters of a plain class and still sees body members", () => {
    const [cls] = classes(
      [
        "class OrderService(repo: OrderRepo, val maxItems: Int, private var retries: Int = 3) extends Base {",
        "  val name: String = \"orders\"",
        "}",
      ].join("\n"),
    );
    expect(cls.properties.map((p) => [p.name, p.type, p.visibility, p.isReadonly])).toEqual([
      ["maxItems", "Int", "public", true],
      ["retries", "Int", "private", false],
      ["name", "String", "public", true],
    ]);
  });

  it("attaches an own-line annotation to the declaration below it", () => {
    const [cls] = classes(["@Singleton", "class OrderController(cc: ControllerComponents) {", "}"].join("\n"));
    expect(cls.decorators).toEqual(["Singleton"]);
  });
});

describe("Scala request access", () => {
  it("reads typed and raw bodies, query strings and headers off the request", () => {
    const body = [
      "val parsed = request.body.validate[CreateOrder]",
      'val page = request.getQueryString("page")',
      'val tenant = request.headers.get("X-Tenant")',
      "val raw = request.body.asJson",
    ];
    expect(extractScalaRequestAccess(body, { name: "create", params: [] })).toEqual([
      { name: "parsed", type: "CreateOrder", binding: "body" },
      { name: "page", type: null, binding: "query" },
      { name: "X-Tenant", type: null, binding: "header" },
      { name: "raw", type: null, binding: "body" },
    ]);
    expect(extractScalaRequestAccess(["Json.fromJson[Item](req.body).fold("], { name: "x", params: [] })).toEqual([
      { name: "body", type: "Item", binding: "body" },
    ]);
  });

  it("lands on FunctionInfo.requestAccess for an action", () => {
    const [fn] = functions(
      [
        "def create(): Action[JsValue] = Action.async(parse.json) { request =>",
        "  request.body.validate[CreateOrder].fold(",
        "    errors => Future.successful(BadRequest(JsError.toJson(errors))),",
        "    order => service.place(order).map(saved => Created(Json.toJson(saved))),",
        "  )",
        "}",
      ].join("\n"),
    );
    expect(fn.requestAccess).toEqual([{ name: "body", type: "CreateOrder", binding: "body" }]);
  });
});

describe("Play routes file", () => {
  it("is recognised by name only", () => {
    expect(isPlayRoutesFile("conf/routes")).toBe(true);
    expect(isPlayRoutesFile("conf/api.routes")).toBe(true);
    expect(isPlayRoutesFile("app/controllers/OrderController.scala")).toBe(false);
    expect(scalaSpec.extractRoutes!(["GET / controllers.Home.index()"], [], "app/Foo.scala")).toEqual([]);
  });

  it("parses verb, path, handler and typed params with path/query bindings", () => {
    const routes = extractPlayRoutes(
      [
        "# Orders",
        "GET     /orders              controllers.OrderController.list(page: Int ?= 1, q: Option[String])",
        "GET     /orders/:id          controllers.OrderController.show(id: Long)",
        "POST    /orders              controllers.OrderController.create()",
        "+ nocsrf",
        "PUT     /orders/:id          @controllers.OrderController.update(id: Long)",
        "GET     /files/*path         controllers.Assets.at(path: String)",
        "GET     /items/$id<[0-9]+>   controllers.api.v1.ItemController.get(id: Long)",
        "->      /api                 api.Routes",
      ].join("\n").split("\n"),
    );
    expect(routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /orders -> OrderController.list",
      "GET /orders/:id -> OrderController.show",
      "POST /orders -> OrderController.create",
      "PUT /orders/:id -> OrderController.update",
      "GET /files/:path -> Assets.at",
      "GET /items/:id -> ItemController.get",
    ]);
    expect(routes[0]!.params).toEqual([
      { name: "page", type: "Int", binding: "query", inferred: true },
      { name: "q", type: "Option[String]", binding: "query", inferred: true },
    ]);
    expect(routes[1]!.params).toEqual([{ name: "id", type: "Long", binding: "route", inferred: true }]);
    // No params → the project-level join fills them from the controller action.
    expect(routes[2]!.params).toBeUndefined();
    expect(routes[2]!.auth).toBeUndefined();
  });
});
