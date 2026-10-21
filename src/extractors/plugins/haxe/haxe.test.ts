import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analyze = (src: string, path = "src/shop/Api.hx"): FileAnalysis => extractWithRegex(src, path, "haxe");

describe("Haxe classes, functions and imports", () => {
  const a = analyze([
    "package shop;",
    "import shop.db.Cars;",
    "import tink.web.routing.*;",
    "using StringTools;",
    "",
    "typedef CarDto = { id:Int, ?note:String }",
    "",
    "interface Repo { function find(id:Int):Null<Car>; }",
    "",
    "@:keep",
    "class CarService extends BaseService implements Repo {",
    "  public var name(default, null):String;",
    "  @:inject var repo:Cars;",
    "  static final LIMIT = 10;",
    "",
    "  public function new(repo:Cars) { this.repo = repo; }",
    "",
    "  public function close(id:Int, ?force:Bool = false):Bool {",
    "    var car = repo.find(id);",
    "    if (car != null && !force) audit(car);",
    "    return Mailer.send(car.email);",
    "  }",
    "",
    "  private function audit(o:Car):Void {}",
    "}",
    "enum abstract Status(String) { var Open = 'open'; }",
  ].join("\n"));

  it("reads classes, interfaces, typedefs and fields", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.implements, c.properties.map((p) => `${p.name}:${p.type}`)])).toEqual([
      ["CarDto", "class", null, [], ["id:Int", "note:String"]],
      ["Repo", "interface", null, [], []],
      ["CarService", "class", "BaseService", ["Repo"], ["name:String", "repo:Cars", "LIMIT:null"]],
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
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["shop.db.Cars", ["Cars"]], ["tink.web.routing", []], ["StringTools", ["StringTools"]]]);
  });
});

describe("Haxe routes and data access", () => {
  it("reads tink_web routes and Express on hxnodejs", () => {
    const a = analyze([
      "class Api {",
      "  public function new() {}",
      "  @:get('/cars/$id')",
      "  public function show(id:Int):Car return Cars.find(id);",
      "  @:post public function close(body:{id:Int}):Noise return Cars.close(body.id);",
      "  @:get public function list() return Cars.all().map(function(o) return o.id);",
      "}",
      "class Server {",
      "  static function main() {",
      '    app.get("/health", health);',
      "  }",
      "}",
    ].join("\n"));
    expect(a.classes[0]!.methods.find((m) => m.name === "list")!.calls.map((c) => c.name)).toEqual(["Cars.all"]);
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /cars/{id} -> Api.show",
      "POST /close -> Api.close",
      "GET /list -> Api.list",
      "GET /health -> health",
    ]);
  });

  it("reads SQL in strings, interpolated or not, and haxe.Http calls", () => {
    const a = analyze([
      "class Db {",
      "  public static function load(cnx:sys.db.Connection, id:Int) {",
      '    cnx.request("SELECT id, total FROM cars WHERE status = \'open\'");',
      "    cnx.request('DELETE FROM sessions WHERE id = $id');",
      '    var h = new haxe.Http("https://crm.example.com/v2/cars");',
      "    h.request(true);",
      "  }",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}@${d.line}`)).toEqual([
      "database SELECT cars@3",
      "database DELETE FROM sessions@4",
      "api-call POST https://crm.example.com/v2/cars@5",
    ]);
  });

  it("reads record-macros models", () => {
    const a = analyze([
      "import sys.db.Types;",
      '@:table("cars")',
      "class Car extends sys.db.Object {",
      "  public var id:SId;",
      "  public var total:SFloat;",
      "  @:relation(cid) public var driver:Driver;",
      "}",
    ].join("\n"), "src/shop/Car.hx");
    const entity = a.classes.find((c) => c.decorators.includes("entity"))!;
    expect([entity.name, entity.decorators.find((d) => d.startsWith("table:")), entity.properties.map((p) => p.name)]).toEqual(["Car", "table:cars", ["id", "total"]]);
    expect(a.entityRelations?.map((r) => `${r.fromEntity}.${r.fromField} ${r.cardinality} ${r.toEntity}`)).toEqual(["Car.driver many-to-one Driver"]);
  });
});
