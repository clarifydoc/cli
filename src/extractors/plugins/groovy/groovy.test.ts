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
    "class OrderService implements Serializable, Comparable<OrderService> {",
    "    def repository",
    "    private final Clock clock",
    "    static int MAX = 5",
    "",
    "    def place(Map params) {",
    "        def fmt = { o -> o.id }",
    "        repository.save params",
    "    }",
    "",
    "    List<Order> recent(int limit = 10, @Named('x') String... tags) {",
    "        transaction(true) {",
    "            println foo(limit)",
    "        }",
    "    }",
    "",
    "    def \"places an order\"() {",
    "        expect: true",
    "    }",
    "",
    "    def list = { render view: 'list' }",
    "}",
  ].join("\n");
  const a = analyze(SRC);
  const cls = a.classes[0]!;

  it("reads def / typed / Spock / closure members, never a call with a trailing closure", () => {
    expect(cls.methods.map((m) => m.name)).toEqual(["place", "recent", "places an order", "list"]);
    expect(cls.implements).toEqual(["Serializable", "Comparable"]);
  });

  it("drops a closure declared inside a method", () => {
    expect(a.functions.map((f) => f.name)).not.toContain("fmt");
    expect(cls.methods.map((m) => m.name)).not.toContain("fmt");
  });

  it("reads parameters, return types and fields", () => {
    expect(method(a, "recent")!.returnType).toBe("List<Order>");
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
      "    importBook b",
      "}",
      "def load(String p) { new JsonSlurper().parse(new File(p)) }",
    ].join("\n"), "scripts/run.groovy");
    expect(a.functions.map((f) => f.name)).toEqual(["<setup>", "load"]);
    expect(a.functions[0]!.calls.map((c) => c.name)).toEqual(["load", "importBook"]);
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
      '    "/api/books"(resources: "book")',
      '    "/api/tags"(controller: "tag") {',
      '      action = [GET: "list", POST: "save"]',
      "    }",
      '    put "/api/authors/$id"(controller: "author", action: "update")',
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
      "GET /api/books BookController.index",
      "GET /api/books/create BookController.create",
      "POST /api/books BookController.save",
      "GET /api/books/{id} BookController.show",
      "GET /api/books/{id}/edit BookController.edit",
      "PUT /api/books/{id} BookController.update",
      "PATCH /api/books/{id} BookController.patch",
      "DELETE /api/books/{id} BookController.delete",
      "GET /api/tags TagController.list",
      "POST /api/tags TagController.save",
      "PUT /api/authors/{id} AuthorController.update",
      "null /admin/stats ReportController.index",
      "null /after PageController.after",
    ]);
  });

  it("routes Grails controller actions by convention, narrowed by allowedMethods", () => {
    const src = [
      "class MyBookController {",
      '  static allowedMethods = [save: "POST"]',
      "  def index() { }",
      "  def save() { }",
      "  private helper() { }",
      "  static def util() { }",
      "}",
    ].join("\n");
    const routes = analyze(src, "grails-app/controllers/app/MyBookController.groovy").routes.map((r) => `${r.httpMethod} ${r.path} ${r.handler}`);
    expect(routes).toEqual(["null /myBook/index MyBookController.index", "POST /myBook/save MyBookController.save"]);
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
    "class BookService {",
    "  def find(String t) {",
    "    def book = Book.findByTitle(t)",
    "    book.delete()",
    "    Paths.get('/tmp')",
    "    new Author(name: t).save()",
    "    sql.rows('''",
    "      SELECT id FROM book_sales",
    "      WHERE count(id) > 0",
    "    ''')",
    "    sql.execute(\"UPDATE books SET x = 1\")",
    '    restTemplate.getForObject("https://api.example.com/books", Map)',
    "  }",
    "}",
  ].join("\n");
  const a = analyze(SRC, "grails-app/services/BookService.groovy");

  it("reads GORM queries and writes with their entity, not library calls", () => {
    expect(a.dataSources.filter((d) => d.kind === "database").map((d) => `${d.name}:${d.access}@${d.line}`)).toEqual([
      // An SQL statement is reported on the line its SQL starts.
      "Book.findByTitle:read@3", "Book.delete:write@4", "Author.save:write@6", "SELECT:read@8", "UPDATE:write@11",
    ]);
  });

  it("reads SQL inside a multi-line string without reading its words as calls", () => {
    expect(method(a, "find")!.calls.map((c) => c.name)).not.toContain("count");
  });

  it("reads HTTP clients", () => {
    expect(a.dataSources.filter((d) => d.kind === "api-call").map((d) => d.name)).toEqual(["GET https://api.example.com/books"]);
  });

  it("types locals so the linker can resolve GORM instance calls", () => {
    expect(method(a, "find")!.localTypes).toEqual([{ name: "book", type: "Book" }]);
  });
});

describe("GORM entities", () => {
  it("reads a domain class, its table and relations", () => {
    const src = [
      "class Book {",
      "  String title",
      "  Author author",
      "  Publisher publisher",
      "  static belongsTo = [author: Author]",
      "  static hasMany = [reviews: Review]",
      "  static transients = ['displayName']",
      "  String displayName",
      "  static mapping = { table 'books' }",
      "}",
    ].join("\n");
    // Through the pipeline: entities merge into the class, and the columns a
    // relation holds (author, publisher) are pruned from it.
    const analysis = analyze(src, "grails-app/domain/app/Book.groovy");
    const book = analysis.classes.find((c) => c.name === "Book")!;
    expect(book.decorators).toEqual(["entity", "gorm", "table:books"]);
    expect(book.properties.filter((p) => !p.isStatic).map((p) => p.name)).toEqual(["title", "displayName"]);
    expect((analysis.entityRelations ?? []).map((r) => `${r.fromField} ${r.cardinality} ${r.toEntity} ${r.confidence}`)).toEqual([
      "reviews one-to-many Review EXTRACTED",
      "author many-to-one Author EXTRACTED",
      "publisher many-to-one Publisher INFERRED",
    ]);
  });

  it("ignores ordinary classes outside grails-app/domain", () => {
    const src = "class Helper {\n  String name\n}";
    expect(extractEntities(analyze(src), src, "groovy").entities).toEqual([]);
  });
});
