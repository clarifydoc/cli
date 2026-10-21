import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor, PACKAGE_MANAGERS } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";
import { lowerUnderscored } from "./routes.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "source/app.d"): FileAnalysis {
  const pre = pluginFor("dlang")!.preprocess!(src, path);
  if (pre && "skip" in pre) throw new Error(pre.skip);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "dlang");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const all = (a: FileAnalysis) => [...a.functions, ...a.classes.flatMap((c) => c.methods)];
const calls = (a: FileAnalysis, name: string) => all(a).find((f) => f.name === name)?.calls.map((c) => c.name) ?? [];

describe("D preprocessing", () => {
  it("refuses a make dependency file", () => {
    const pre = pluginFor("dlang")!.preprocess!("build/main.o: src/main.c include/util.h \\\n  include/config.h\n", "build/main.d");
    expect(pre).toEqual({ skip: "make dependency file, not D" });
  });

  it("blanks comments and the strings whose text reads as code, keeping every line", () => {
    const src = [
      "/* render(x) */ void a() {",
      "  /+ nested /+ helper(y) +/ still +/",
      "  enum code = q{ mixinCall(z); };",
      "  auto q = `SELECT count(*)",
      "    FROM t`;",
      "  run(\"one-line(kept)\");",
      "}",
    ].join("\n");
    const pre = pluginFor("dlang")!.preprocess!(src, "source/a.d") as { sourceText: string };
    const lines = pre.sourceText.split("\n");
    expect(lines.map((l) => l.length)).toEqual(src.split("\n").map((l) => l.length));
    expect(calls(analyze(src), "a")).toEqual(["run"]);
  });
});

describe("D declarations", () => {
  const a = analyze([
    "module app.service;",
    "",
    "/// Loads players.",
    "@safe Player[] loadPlayers(string role = \"admin\", int limit = 10) {",
    "  if (!isValid(role)) return [];",
    "  auto ids = fetchIds(role);",
    "  auto names = ids.project!(x => x.name)(limit);",
    "  int helper(int x) { return compute(x); }",
    "  assert(helper(1) > 0);",
    "  return to!(Player[])(cast(int) limit);",
    "}",
    "",
    "auto pick(alias pred, R)(R range, size_t n)",
    "{",
    "  return range.filter!pred;",
    "}",
    "",
    "private void secret() {}",
    "",
    "class PlayerService : BaseService, IPlayerService {",
    "  private {",
    "    PlayerRepo m_repo;",
    "    int m_hits, m_misses;",
    "  }",
    "  static struct Cache {",
    "    string key;",
    "    void clear() { reset(); }",
    "  }",
    "  this(PlayerRepo repo) { m_repo = repo; }",
    "  @property int hits() const { return m_hits; }",
    "  override string describe() nothrow {",
    "    return m_repo.describe();",
    "  }",
    "}",
    "",
    "interface IPlayerService {",
    "  Player find(int id);",
    "}",
    "",
    "enum Role : ubyte {",
    "  admin,",
    "  player",
    "}",
  ].join("\n"));

  it("reads functions with return types, parameters (runtime ones of a template) and protection", () => {
    expect(a.functions.map((f) => [f.name, f.returnType, f.isExported])).toEqual([
      ["loadPlayers", "Player[]", true], ["pick", null, true], ["secret", "void", false],
    ]);
    expect(a.functions[0]!.params).toEqual([
      { name: "role", type: "string", defaultValue: "\"admin\"" }, { name: "limit", type: "int", defaultValue: "10" },
    ]);
    expect(a.functions[1]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["range:R", "n:size_t"]);
    expect(a.functions[0]!.decorators).toEqual(["safe"]);
  });

  it("reads calls — template instances by their name, a nested function's as the enclosing one's, never keywords", () => {
    expect(calls(a, "loadPlayers")).toEqual(["isValid", "fetchIds", "ids.project", "helper", "compute", "to"]);
  });

  it("reads classes, interfaces, structs and enums with their bases, fields and members", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.implements.join(",")])).toEqual([
      ["PlayerService", "class", "BaseService", "IPlayerService"], ["Cache", "class", null, ""],
      ["IPlayerService", "interface", null, ""], ["Role", "enum", null, ""],
    ]);
    const svc = a.classes[0]!;
    expect(svc.properties.map((p) => `${p.name}:${p.type}:${p.visibility}`)).toEqual([
      "m_repo:PlayerRepo:private", "m_hits:int:private", "m_misses:int:private",
    ]);
    // The nested struct's method is its own; the constructor takes the class's name.
    expect(svc.methods.map((m) => [m.name, m.decorators.join(",")])).toEqual([["PlayerService", ""], ["hits", "property"], ["describe", ""]]);
    expect(a.classes[1]!.methods.map((m) => m.name)).toEqual(["clear"]);
    expect(calls(a, "describe")).toEqual(["m_repo.describe"]);
  });
});

describe("D imports", () => {
  it("reads every module of an import, selective lists, aliases and local imports", () => {
    const a = analyze([
      "import std.stdio, std.string;",
      "import vibe.web.rest : RestInterfaceClient,",
      "  registerRestInterface;",
      "static import std.file;",
      "import io = std.stdio;",
      "void f() { import app.models : Player; }",
    ].join("\n"));
    expect(a.imports.map((i) => `${i.source}[${i.specifiers}]@${i.line}`)).toEqual([
      "std.stdio[stdio]@1", "std.string[string]@1", "vibe.web.rest[RestInterfaceClient,registerRestInterface]@2",
      "std.file[file]@4", "std.stdio[io]@5", "app.models[Player]@6",
    ]);
  });
});

describe("vibe.d routes", () => {
  it("reads URLRouter registrations: handlers, chains, continuation lines, match and inline delegates", () => {
    const a = analyze([
      "import vibe.vibe;",
      "void setup(URLRouter r) {",
      "  r.get(\"/\", &index);",
      "  r.post(\"/players/:id\", &updatePlayer).delete_(\"/players/:id\", &removePlayer);",
      "  r",
      "    .put(\"/items/:id\", toDelegate(&putItem));",
      "  r.match(HTTPMethod.PATCH, \"/items/:id\", &patchItem);",
      "  r.get(\"/dump\", (req, res) => dumpAll(req, res));",
      "  r.get(\"*\", serveStaticFiles(\"public/\"));",
      "  auto cfg = settings.get(\"/x\", y);",
      "}",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET / -> index []", "POST /players/:id -> updatePlayer []", "DELETE /players/:id -> removePlayer []",
      "PUT /items/:id -> putItem []", "PATCH /items/:id -> patchItem []", "GET /dump -> null [dumpAll]",
    ]);
  });

  it("names REST methods the way vibe does (its own examples' paths)", () => {
    expect(["SomeInfo", "MyID", "getHTMLEntity", "Example1API", "IDTest"].map(lowerUnderscored)).toEqual([
      "some_info", "myid", "get_html_entity", "example1_api", "id_test",
    ]);
    const a = analyze([
      "import vibe.web.rest;",
      "@rootPathFromName",
      "interface Example1API {",
      "  string getSomeInfo();",
      "  int postSum(int a, int b);",
      "  @property string getter();",
      "  @path(\":param/data\") @method(HTTPMethod.POST)",
      "  int getParametersInURL(string _param);",
      "  int getMyID(int id);",
      "  @property NestedAPI nestedModule();",
      "  @noRoute void hidden();",
      "}",
      "interface NestedAPI {",
    "  int getNumber();",
    "}",
      "class Example1 : Example1API {",
      "  string getSomeInfo() { return compute(); }",
      "}",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /example1_api/some_info -> Example1.getSomeInfo",
      "POST /example1_api/sum -> Example1API.postSum",
      "GET /example1_api/getter -> Example1API.getter",
      "POST /example1_api/:param/data -> Example1API.getParametersInURL",
      "GET /example1_api/:id/myid -> Example1API.getMyID",
      "GET /example1_api/nested_module/number -> NestedAPI.getNumber",
    ]);
  });

  it("reads a REST interface under a same-file registration prefix, and web interfaces with their inherited routes", () => {
    const a = analyze([
      "import vibe.d;",
      "interface IShop {",
    "  Part[] getParts();",
    "  void addCar(Car c);",
    "}",
      "class Shop : IShop {",
      "  Part[] getParts() { return m_repo.all(); }",
      "  void addCar(Car c) { m_repo.save(c); }",
      "}",
      "class BasePages {",
    "  void index() {}",
    "  void getAbout() {}",
    "}",
      "@path(\"/admin\")",
      "class AdminPages : BasePages {",
      "  @auth void getPlayers() {}",
      "  @path(\"/players/:id\") void postPlayer(string _id) {}",
      "  void search(string q) {}",
      "  private void helper() {}",
      "  static void util() {}",
      "}",
      "void main() {",
      "  auto router = new URLRouter;",
      "  router.registerRestInterface(new Shop(repo), \"/api\");",
      "  auto pages = new AdminPages;",
      "  router.registerWebInterface(pages);",
      "}",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware}]`)).toEqual([
      "GET /api/parts -> Shop.getParts []", "POST /api/car -> Shop.addCar []",
      "GET /admin -> BasePages.index []", "GET /admin/about -> BasePages.getAbout []",
      "GET /admin/players -> AdminPages.getPlayers [auth]", "POST /admin/players/:id -> AdminPages.postPlayer []",
      "POST /admin/search -> AdminPages.search []",
    ]);
  });

  it("reads no route from a file that does not use vibe.d", () => {
    expect(analyze("interface I { @path(\"/x\") void getX(); }").routes).toEqual([]);
  });
});

describe("D data access", () => {
  it("reads SQL in every string form, HTTP requests and MongoDB collections", () => {
    const a = analyze([
      "import vibe.db.mongo.mongo;",
      "class Store {",
      "  MongoCollection m_cars;",
      "  this(MongoDatabase db) { m_cars = db[\"cars\"]; }",
      "  void archive(Database sql) {",
      "    sql.execute(`DELETE FROM archived_cars",
      "      WHERE created < ?`);",
      "    auto rows = sql.execute(\"SELECT id FROM cars WHERE paid = 1\");",
      "    m_cars.insertOne(doc);",
      "    auto o = m_cars.findOne([\"_id\": id]);",
      "    requestHTTP(\"https://hooks.example.com/archive\", (scope req) {",
      "      req.method = HTTPMethod.POST;",
      "    }, (scope res) {});",
      "  }",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}@${d.line}`)).toEqual([
      "database DELETE FROM archived_cars write@6",
      "database SELECT cars read@8",
      "database cars.insertOne cars write@9",
      "database cars.findOne cars read@10",
      "api-call POST https://hooks.example.com/archive - -@11",
    ]);
  });
});

describe("dub", () => {
  const ctx = (path: string) => ({ declaredIn: path, path, readSibling: async () => null });
  const spec = PACKAGE_MANAGERS.find((m) => m.ecosystem === "dub")!;

  it("reads dub.json dependencies, configurations and sub-packages included", async () => {
    const json = JSON.stringify({
      name: "shop",
      dependencies: { "vibe-d": "~>0.9", "vibe-d:tls": "*", ":common": "*", d2sqlite3: { version: "~>1.0", optional: true } },
      configurations: [{ name: "test", dependencies: { "unit-threaded": "~>2.1" } }],
    });
    expect((await spec.manifests[0]!.parse(json, ctx("dub.json"))).map((p) => `${p.name}@${p.version}:${p.scope}`)).toEqual([
      "vibe-d@~>0.9:prod", "d2sqlite3@~>1.0:optional", "unit-threaded@~>2.1:prod",
    ]);
  });

  it("reads dub.sdl dependencies and matches imports to packages", async () => {
    const sdl = 'name "shop"\ndependency "vibe-d" version="~>0.9"\ndependency "mysql-native" version="~>3.2" optional=true\n';
    expect((await spec.manifests[1]!.parse(sdl, ctx("dub.sdl"))).map((p) => `${p.name}@${p.version}:${p.scope}`)).toEqual([
      "vibe-d@~>0.9:prod", "mysql-native@~>3.2:optional",
    ]);
    expect([spec.importKey!("vibe.http.router"), spec.packageKey!("vibe-d"), spec.importKey!("std.stdio")]).toEqual(["vibe", "vibe", null]);
  });
});

describe("D line endings", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/sample-d-app/source/**/*.d", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} with CRLF or CR line endings as with LF`, () => {
      const lf = readFileSync(resolve(root, rel), "utf-8").replace(/\r\n?/g, "\n");
      expect(analyze(lf.replace(/\n/g, "\r\n"), rel)).toEqual(analyze(lf, rel));
      expect(analyze(lf.replace(/\n/g, "\r"), rel)).toEqual(analyze(lf, rel));
    });
  }
});
