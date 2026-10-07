import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analyze = (src: string, path = "src/shop/Api.hx"): FileAnalysis => extractWithRegex(src, path, "haxe");

describe("Haxe classes, functions and imports", () => {
  const a = analyze([
    "package shop;",
    "import shop.db.Orders;",
    "import tink.web.routing.*;",
    "using StringTools;",
    "",
    "typedef OrderDto = { id:Int, ?note:String }",
    "",
    "interface Repo { function find(id:Int):Null<Order>; }",
    "",
    "@:keep",
    "class OrderService extends BaseService implements Repo {",
    "  public var name(default, null):String;",
    "  @:inject var repo:Orders;",
    "  static final LIMIT = 10;",
    "",
    "  public function new(repo:Orders) { this.repo = repo; }",
    "",
    "  public function close(id:Int, ?force:Bool = false):Bool {",
    "    var order = repo.find(id);",
    "    if (order != null && !force) audit(order);",
    "    return Mailer.send(order.email);",
    "  }",
    "",
    "  private function audit(o:Order):Void {}",
    "}",
    "enum abstract Status(String) { var Open = 'open'; }",
  ].join("\n"));

  it("reads classes, interfaces, typedefs and fields", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.implements, c.properties.map((p) => `${p.name}:${p.type}`)])).toEqual([
      ["OrderDto", "class", null, [], ["id:Int", "note:String"]],
      ["Repo", "interface", null, [], []],
      ["OrderService", "class", "BaseService", ["Repo"], ["name:String", "repo:Orders", "LIMIT:null"]],
      ["Status", "enum", null, [], []],
    ]);
    expect(a.classes[2]!.properties[1]!.decorators).toEqual([":inject"]);
  });

  it("reads methods with optional typed params and return types", () => {
    const close = a.classes[2]!.methods.find((m) => m.name === "close")!;
    expect(close.params).toEqual([
      { name: "id", type: "Int", defaultValue: null },
      { name: "force", type: "Bool", defaultValue: "false" },
    ]);
    expect(close.returnType).toBe("Bool");
    expect(close.calls.map((c) => c.name)).toEqual(["repo.find", "audit", "Mailer.send"]);
    expect(a.classes[2]!.methods.map((m) => [m.name, m.isExported])).toEqual([["new", true], ["close", true], ["audit", false]]);
  });

  it("reads imports and using", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["shop.db.Orders", ["Orders"]], ["tink.web.routing", []], ["StringTools", ["StringTools"]]]);
  });
});

describe("Haxe routes and data access", () => {
  it("reads tink_web routes and Express on hxnodejs", () => {
    const a = analyze([
      "class Api {",
      "  public function new() {}",
      "  @:get('/orders/$id')",
      "  public function show(id:Int):Order return Orders.find(id);",
      "  @:post public function close(body:{id:Int}):Noise return Orders.close(body.id);",
      "  @:get public function list() return Orders.all().map(function(o) return o.id);",
      "}",
      "class Server {",
      "  static function main() {",
      '    app.get("/health", health);',
      "  }",
      "}",
    ].join("\n"));
    expect(a.classes[0]!.methods.find((m) => m.name === "list")!.calls.map((c) => c.name)).toEqual(["Orders.all"]);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /orders/{id} -> Api.show",
      "POST /close -> Api.close",
      "GET /list -> Api.list",
      "GET /health -> health",
    ]);
  });

  it("reads SQL in strings, interpolated or not, and haxe.Http calls", () => {
    const a = analyze([
      "class Db {",
      "  public static function load(cnx:sys.db.Connection, id:Int) {",
      '    cnx.request("SELECT id, total FROM orders WHERE status = \'open\'");',
      "    cnx.request('DELETE FROM sessions WHERE id = $id');",
      '    var h = new haxe.Http("https://crm.example.com/v2/orders");',
      "    h.request(true);",
      "  }",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}@${d.line}`)).toEqual([
      "database SELECT orders@3",
      "database DELETE FROM sessions@4",
      "api-call POST https://crm.example.com/v2/orders@5",
    ]);
  });

  it("reads record-macros models", () => {
    const a = analyze([
      "import sys.db.Types;",
      '@:table("orders")',
      "class Order extends sys.db.Object {",
      "  public var id:SId;",
      "  public var total:SFloat;",
      "  @:relation(cid) public var customer:Customer;",
      "}",
    ].join("\n"), "src/shop/Order.hx");
    const entity = a.classes.find((c) => c.decorators.includes("entity"))!;
    expect([entity.name, entity.decorators.find((d) => d.startsWith("table:")), entity.properties.map((p) => p.name)]).toEqual(["Order", "table:orders", ["id", "total"]]);
    expect(a.entityRelations?.map((r) => `${r.fromEntity}.${r.fromField} ${r.cardinality} ${r.toEntity}`)).toEqual(["Order.customer many-to-one Customer"]);
  });
});
