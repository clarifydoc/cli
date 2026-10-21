import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor } from "../../registry.js";
import { extractEntities } from "../../entities/index.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/main/groovy/App.groovy") {
  const pre = pluginFor("groovy")!.preprocess!(src, path);
  const pre2 = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(pre2?.sourceText ?? src, path, "groovy");
  pre2?.postExtract?.(analysis, src);
  return analysis;
}
const method = (a: ReturnType<typeof analyze>, name: string) => a.classes.flatMap((c) => c.methods).find((m) => m.name === name);

describe("Groovy declarations", () => {
  const SRC = [
    "class CarService implements Serializable, Comparable<CarService> {",
    "    def repository",
    "    private final Clock clock",
    "    static int MAX = 5",
    "",
    "    def place(Map params) {",
    "        def fmt = { o -> o.id }",
    "        repository.save params",
    "    }",
    "",
    "    List<Car> recent(int limit = 10, @Named('x') String... tags) {",
    "        transaction(true) {",
    "            println foo(limit)",
    "        }",
    "    }",
    "",
    "    def \"places a car\"() {",
    "        expect: true",
    "    }",
    "",
    "    def list = { render view: 'list' }",
    "}",
  ].join("\n");
  const a = analyze(SRC);
  const cls = a.classes[0]!;

  it("reads def / typed / Spock / closure members, never a call with a trailing closure", () => {
    expect(cls.methods.map((m) => m.name)).toEqual(["place", "recent", "places a car", "list"]);
    expect(cls.implements).toEqual(["Serializable", "Comparable"]);
  });

  it("drops a closure declared inside a method", () => {
    expect(a.functions.map((f) => f.name)).not.toContain("fmt");
    expect(cls.methods.map((m) => m.name)).not.toContain("fmt");
  });

  it("reads parameters, return types and fields", () => {
    expect(method(a, "recent")!.returnType).toBe("List<Car>");
    expect(method(a, "recent")!.params).toEqual([
      { name: "limit", type: "int", defaultValue: "10" },
      { name: "tags", type: "String[]", defaultValue: null },
    ]);
    expect(cls.properties.map((p) => [p.name, p.type, p.isStatic])).toEqual([
      ["repository", null, false], ["clock", "Clock", false], ["MAX", "int", true],
    ]);
  });

  it("reads command calls written without parentheses", () => {
    expect(method(a, "place")!.calls.map((c) => c.name)).toEqual(["repository.save"]);
    // `println` is stdlib noise (CALL_NOISE); its argument call is still read.
    expect(method(a, "recent")!.calls.map((c) => c.name)).toEqual(["transaction", "foo"]);
    expect(method(a, "list")!.calls.map((c) => c.name)).toEqual(["render"]);
  });
});

describe("Groovy scripts", () => {
  it("run their top-level statements as <setup>, skipping annotation lines", () => {
    const a = analyze([
      "@Grab('org.x:y:1')",
      "import groovy.json.JsonSlurper",
      "def data = load 'x.json'",
      "data.each { b ->",
      "    importStadium b",
      "}",
      "def load(String p) { new JsonSlurper().parse(new File(p)) }",
    ].join("\n"), "scripts/run.groovy");
    expect(a.functions.map((f) => f.name)).toEqual(["<setup>", "load"]);
    expect(a.functions[0]!.calls.map((c) => c.name)).toEqual(["load", "importStadium"]);
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([["groovy.json.JsonSlurper", ["JsonSlurper"]]]);
  });
});

describe("Groovy routes", () => {
  it("reads Grails UrlMappings: literals, resources, method maps, groups — never templates or views", () => {
    const src = [
      "class UrlMappings {",
      "  static mappings = {",
      '    "/$controller/$action?/$id?(.$format)?" { constraints { } }',
      '    "/"(view: "/index")',
      '    "/api/stadiums"(resources: "stadium")',
      '    "/api/tags"(controller: "tag") {',
      '      action = [GET: "list", POST: "save"]',
      "    }",
      '    put "/api/scouts/$id"(controller: "scout", action: "update")',
      '    group "/admin", {',
      '      "/stats"(controller: "report")',
      "    }",
      '    "/after"(controller: "page", action: "after")',
      '    "500"(view: "/error")',
      "  }",
      "}",
    ].join("\n");
    const routes = analyze(src, "grails-app/controllers/app/UrlMappings.groovy").routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`);
    expect(routes).toEqual([
      "GET /api/stadiums StadiumController.index",
      "GET /api/stadiums/create StadiumController.create",
      "POST /api/stadiums StadiumController.save",
      "GET /api/stadiums/{id} StadiumController.show",
      "GET /api/stadiums/{id}/edit StadiumController.edit",
      "PUT /api/stadiums/{id} StadiumController.update",
      "PATCH /api/stadiums/{id} StadiumController.patch",
      "DELETE /api/stadiums/{id} StadiumController.delete",
      "GET /api/tags TagController.list",
      "POST /api/tags TagController.save",
      "PUT /api/scouts/{id} ScoutController.update",
      "null /admin/stats ReportController.index",
      "null /after PageController.after",
    ]);
  });

  it("routes Grails controller actions by convention, narrowed by allowedMethods", () => {
    const src = [
      "class MyStadiumController {",
      '  static allowedMethods = [save: "POST"]',
      "  def index() { }",
      "  def save() { }",
      "  private helper() { }",
      "  static def util() { }",
      "}",
    ].join("\n");
    const routes = analyze(src, "grails-app/controllers/app/MyStadiumController.groovy").routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`);
    expect(routes).toEqual(["null /myStadium/index MyStadiumController.index", "POST /myStadium/save MyStadiumController.save"]);
  });

  it("reads Spring and Micronaut annotations", () => {
    const spring = [
      "@RestController",
      '@RequestMapping("/api/stock")',
      "class StockController {",
      '  @GetMapping("/{sku}")',
      "  Map one(@PathVariable String sku) { [:] }",
      '  @RequestMapping(value = ["/a", "/b"], method = RequestMethod.DELETE) void drop() { }',
      "}",
    ].join("\n");
    expect(analyze(spring).routes.map((r) => `${r.httpMethod} ${r.path}`)).toEqual(["GET /api/stock/{sku}", "DELETE /api/stock/a", "DELETE /api/stock/b"]);
    const micronaut = ['@Controller("/hello")', "class Hello {", '  @Get("/{name}")', "  String greet(String name) { name }", "}"].join("\n");
    expect(analyze(micronaut).routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`)).toEqual(["GET /hello/{name} Hello.greet"]);
  });
});

describe("Groovy data access", () => {
  const SRC = [
    "class StadiumService {",
    "  def find(String t) {",
    "    def stadium = Stadium.findByTitle(t)",
    "    stadium.delete()",
    "    Paths.get('/tmp')",
    "    new Scout(name: t).save()",
    "    sql.rows('''",
    "      SELECT id FROM stadium_sales",
    "      WHERE count(id) > 0",
    "    ''')",
    "    sql.execute(\"UPDATE stadiums SET x = 1\")",
    '    restTemplate.getForObject("https://api.example.com/stadiums", Map)',
    "  }",
    "}",
  ].join("\n");
  const a = analyze(SRC, "grails-app/services/StadiumService.groovy");

  it("reads GORM queries and writes with their entity, not library calls", () => {
    expect(a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.name}:${d.access}@${d.line}`)).toEqual([
      // An SQL statement is reported on the line its SQL starts.
      "Stadium.findByTitle:read@3", "Stadium.delete:write@4", "Scout.save:write@6", "SELECT:read@8", "UPDATE:write@11",
    ]);
  });

  it("reads SQL inside a multi-line string without reading its words as calls", () => {
    expect(method(a, "find")!.calls.map((c) => c.name)).not.toContain("count");
  });

  it("reads HTTP clients", () => {
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => d.name)).toEqual(["GET https://api.example.com/stadiums"]);
  });

  it("types locals so the linker can resolve GORM instance calls", () => {
    expect(method(a, "find")!.localTypes).toEqual([{ name: "stadium", type: "Stadium" }]);
  });
});

describe("GORM entities", () => {
  it("reads a domain class, its table and relations", () => {
    const src = [
      "class Stadium {",
      "  String title",
      "  Scout scout",
      "  Publisher publisher",
      "  static belongsTo = [scout: Scout]",
      "  static hasMany = [reviews: Review]",
      "  static transients = ['displayName']",
      "  String displayName",
      "  static mapping = { table 'stadiums' }",
      "}",
    ].join("\n");
    // Through the pipeline: entities merge into the class, and the columns a
    // relation holds (scout, publisher) are pruned from it.
    const analysis = analyze(src, "grails-app/domain/app/Stadium.groovy");
    const stadium = analysis.classes.find((c) => c.name === "Stadium")!;
    expect(stadium.decorators).toEqual(["entity", "gorm", "table:stadiums"]);
    expect(stadium.properties.filter((p) => !p.isStatic).map((p) => p.name)).toEqual(["title", "displayName"]);
    expect((analysis.entityRelations ?? []).map((r) => `${r.fromField} ${r.cardinality} ${r.toEntity} ${r.confidence}`)).toEqual([
      "reviews one-to-many Review EXTRACTED",
      "scout many-to-one Scout EXTRACTED",
      "publisher many-to-one Publisher INFERRED",
    ]);
  });

  it("ignores ordinary classes outside grails-app/domain", () => {
    const src = "class Helper {\n  String name\n}";
    expect(extractEntities(analyze(src), src, "groovy").entities).toEqual([]);
  });
});
