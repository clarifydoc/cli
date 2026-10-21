import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor, PACKAGE_MANAGERS } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/app.nim"): FileAnalysis {
  const pre = pluginFor("nim")!.preprocess!(src, path);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "nim");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const fn = (a: FileAnalysis, name: string) => a.functions.find((f) => f.name === name);
const calls = (a: FileAnalysis, name: string) => fn(a, name)?.calls.map((c) => c.name) ?? [];

describe("Nim routines and types", () => {
  const a = analyze([
    "#[ a block comment: proc ghost() = discard ]#",
    "type",
    "  Rank* = enum guest, player, admin",
    "  Base = object of RootObj",
    "    id*: int",
    "  Player* = ref object of Base",
    "    name*, email: string",
    "    rank: Rank",
    "",
    "proc loadPlayer*(id: int; cache = true): Player {.async.} =",
    "  ## Loads one player.",
    "  let row = db.getRow(sql\"SELECT * FROM players WHERE id = ?\", id)",
    "  if row.len == 0 and cache: return nil",
    "  result = toPlayer row",
    "  echo \"loaded\"",
    "  proc local(x: int): int = x * 2",
    "  discard local(3)",
    "",
    "func display(u: Player, a, b: int): string = u.name & $a",
    "",
    "proc sendMail(",
    "  to: string,",
    "  body: string",
    ") =",
    "  smtp.send to, body",
    "  for line in body.splitLines:",
    "    logLine line",
  ].join("\n"));

  it("reads routines with their export marker, parameters and result type — never nested ones", () => {
    expect(a.functions.map((f) => [f.name, f.isExported, f.returnType])).toEqual([
      ["loadPlayer", true, "Player"], ["display", false, "string"], ["sendMail", false, null],
    ]);
    expect(fn(a, "loadPlayer")!.isAsync).toBe(true);
    expect(fn(a, "loadPlayer")!.params).toEqual([
      { name: "id", type: "int", defaultValue: null }, { name: "cache", type: null, defaultValue: "true" },
    ]);
    // `a, b: int` share their type.
    expect(fn(a, "display")!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["u:Player", "a:int", "b:int"]);
  });

  it("reads a signature wrapped down to column 0 and a routine that runs to the end of the file", () => {
    expect(fn(a, "sendMail")!.params.map((p) => p.name)).toEqual(["to", "body"]);
    expect([fn(a, "sendMail")!.line, fn(a, "sendMail")!.endLine]).toEqual([21, 27]);
    expect(calls(a, "sendMail")).toEqual(["smtp.send", "logLine"]);
  });

  it("reads parenthesized, method and command calls — never keywords", () => {
    // `echo` is stdlib noise; a nested proc's calls belong to its enclosing routine.
    expect(calls(a, "loadPlayer")).toEqual(["db.getRow", "toPlayer", "local"]);
  });

  it("reads object, ref object and enum types with their base and fields", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.isExported])).toEqual([
      ["Rank", "enum", null, true], ["Base", "class", "RootObj", false], ["Player", "class", "Base", true],
    ]);
    expect(a.classes[2]!.properties.map((p) => `${p.name}:${p.type}:${p.visibility}`)).toEqual([
      "name:string:public", "email:string:private", "rank:Rank:private",
    ]);
  });
});

describe("Nim imports", () => {
  it("reads lists, bracket groups, aliases, `from` and `include` across lines", () => {
    const a = analyze([
      "import std/[os, strutils], ./db",
      "import",
      "  jester, # web",
      "  models",
      "import system except Thread",
      "import json as js",
      "from htmlgen import tr, `div`, nil",
      "include \"templates/main.tmpl\"",
    ].join("\n"));
    expect(a.imports.map((i) => `${i.source}[${i.specifiers}]@${i.line}`)).toEqual([
      "std/os[os]@1", "std/strutils[strutils]@1", "./db[db]@1", "jester[jester]@2", "models[models]@2",
      "system[system]@5", "json[js]@6", "htmlgen[tr]@7", "templates/main.tmpl[main.tmpl]@8",
    ]);
  });
});

describe("Nim routes", () => {
  it("reads a Jester routes block: path parameters, inline and indented handler bodies, local routers", () => {
    const a = analyze([
      "import jester",
      "router admin:",
      "  get \"/stats\":",
      "    resp renderStats()",
      "routes:",
      "  get \"/players/@id\":",
      "    let player = findPlayer(@\"id\")",
      "    resp %player",
      "  post \"/players\": createPlayer(request.body)",
      "  get re\"/files/(.*)\":",
      "    sendFile(\"x\")",
      "  extend admin, \"/admin\"",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} [${r.calls.map((c) => c.name)}]`)).toEqual([
      // A router extended under a prefix keeps its own declaration line.
      "GET /admin/stats [resp,renderStats]", "GET /players/{id} [findPlayer,resp]", "POST /players [createPlayer]", "GET /files/(.*) [sendFile]",
    ]);
    // The route DSL is no call of the setup code.
    expect(calls(a, "<setup>")).not.toContain("get");
  });

  it("reads Prologue routes, methods and a pattern list mounted in the same file", () => {
    const a = analyze([
      "import prologue",
      "import ./views",
      "let apiPatterns = @[",
      "  pattern(\"/players\", views.listPlayers, @[HttpGet, HttpPost]),",
      "  pattern(\"/players/{id}\", showPlayer),",
      "]",
      "var app = newApp()",
      "app.addRoute(apiPatterns, \"/api\")",
      "app.addRoute(\"/login\", login, HttpPost, middlewares = @[csrfMiddleware()])",
      "app.get(\"/\", home)",
      "app.run()",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.middleware}]`)).toEqual([
      "GET /api/players -> listPlayers []", "POST /api/players -> listPlayers []", "GET /api/players/{id} -> showPlayer []",
      "POST /login -> login [csrfMiddleware]", "GET / -> home []",
    ]);
  });

  it("reads no Prologue route from a file that does not import it", () => {
    expect(analyze("let p = pattern(\"/x\", y)\nclient.get(\"/x\", h)").routes).toEqual([]);
  });
});

describe("Nim data access", () => {
  it("reads SQL in strings — triple-quoted ones included — without reading them as code", () => {
    const a = analyze([
      "proc report(db: DbConn) =",
      "  let rows = db.getAllRows(sql\"\"\"",
      "select name, count(*)",
      "from cars",
      "group by name",
      "\"\"\", 10)",
      "  db.exec(sql\"UPDATE cars SET seen = 1\")",
      "  publish rows",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.name} ${d.entity} ${d.access ?? "-"}@${d.line}`)).toEqual([
      // A statement is located where its text starts.
      "SELECT cars read@3", "UPDATE cars write@7",
    ]);
    expect(calls(a, "report")).toEqual(["db.getAllRows", "db.exec", "publish"]);
    expect(fn(a, "report")!.endLine).toBe(8);
  });

  it("reads httpclient and Karax ajax calls, URLs bound to a local included", () => {
    const a = analyze([
      "proc sync() =",
      "  let client = newHttpClient()",
      "  discard client.getContent(\"https://api.example.com/v1/items\")",
      "  discard client.request(\"https://api.example.com/v1/items\", httpMethod = HttpPost)",
      "proc onSave(id: int) =",
      "  let uri = makeUri(\"/players/\" & $id & \"/save\")",
      "  ajaxPost(uri, @[], form)",
      "  ajaxGet(makeUri(\"threads.json?start=\" & $start), @[], cb)",
    ].join("\n"));
    expect(a.dataSources.map((d) => d.name)).toEqual([
      "GET https://api.example.com/v1/items", "POST https://api.example.com/v1/items", "POST /players/{id}/save", "GET /threads.json",
    ]);
  });
});

describe("nimble", () => {
  it("reads requires lines — version constraints, commit pins, URLs — but not the compiler", async () => {
    const spec = PACKAGE_MANAGERS.find((m) => m.ecosystem === "nimble")!;
    const text = [
      "bin = @[\"app\"]",
      "requires \"nim >= 1.6.0\"",
      "requires \"jester >= 0.5.0\", \"karax#45bac6b\" # web",
      "requires \"https://github.com/user/norm.git\"",
    ].join("\n");
    const ctx = { declaredIn: "app.nimble", path: "app.nimble", readSibling: async () => null };
    expect((await spec.manifests[0]!.parse(text, ctx)).map((p) => `${p.name}@${p.version}`)).toEqual([
      "jester@0.5.0", "karax@45bac6b", "norm@null",
    ]);
    expect(spec.importKey!("pkg/jester/private/utils")).toBe("jester");
    expect(spec.importKey!("std/os")).toBeNull();
  });
});

describe("Nim line endings", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/sample-nim-app/**/*.nim", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} with CRLF or CR line endings as with LF`, () => {
      const lf = readFileSync(resolve(root, rel), "utf-8").replace(/\r\n?/g, "\n");
      expect(analyze(lf.replace(/\n/g, "\r\n"), rel)).toEqual(analyze(lf, rel));
      expect(analyze(lf.replace(/\n/g, "\r"), rel)).toEqual(analyze(lf, rel));
    });
  }
});
