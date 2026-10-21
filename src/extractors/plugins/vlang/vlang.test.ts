import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { globSync } from "tinyglobby";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import { pluginFor, PACKAGE_MANAGERS } from "../../registry.js";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the plugin's preprocess, as the analyzer runs it. */
function analyze(src: string, path = "src/app.v"): FileAnalysis {
  const pre = pluginFor("vlang")!.preprocess!(src, path);
  if (pre && "skip" in pre) throw new Error(pre.skip);
  const p = pre && "sourceText" in pre ? pre : null;
  const analysis = extractWithRegex(p?.sourceText ?? src, path, "vlang");
  p?.postExtract?.(analysis, src);
  return analysis;
}
const all = (a: FileAnalysis) => [...a.functions, ...a.classes.flatMap((c) => c.methods)];
const calls = (a: FileAnalysis, name: string) => all(a).find((f) => f.name === name)?.calls.map((c) => c.name) ?? [];
/** `analyze`, or the reason a foreign `.v` file is refused. */
const analyzeAny = (src: string, path: string): FileAnalysis | string => {
  try {
    return analyze(src, path);
  } catch (e) {
    return String(e);
  }
};

describe("V preprocessing", () => {
  const skip = (src: string, path = "rtl/counter.v") => pluginFor("vlang")!.preprocess!(src, path);

  it("refuses Verilog and Coq sources that share the extension", () => {
    expect(skip("module counter(input clk, output reg [3:0] q);\n  always @(posedge clk) q <= q + 1;\nendmodule\n")).toEqual({ skip: "Verilog module, not V" });
    expect(skip("Require Import Arith.\nTheorem plus_O : forall n, n + 0 = n.\nProof.\n  auto.\nQed.\n", "theories/Plus.v")).toEqual({ skip: "Coq proof script, not V" });
  });

  it("keeps V — and a `.vsh` script with no declaration", () => {
    expect(skip("module main\n\nfn main() {\n  println('hi')\n}\n", "main.v")).not.toHaveProperty("skip");
    expect(skip("exec('make')\n", "build.vsh")).not.toHaveProperty("skip");
  });

  it("blanks comments and multi-line strings, keeping every line", () => {
    const src = "fn help() {\n  /* render(x) /* nested */ */\n  text := 'Usage:\n  run(args) now'\n  show(text)\n}\n";
    const pre = pluginFor("vlang")!.preprocess!(src, "help.v") as { sourceText: string };
    expect(pre.sourceText.split("\n").map((l) => l.length)).toEqual(src.split("\n").map((l) => l.length));
    expect(calls(analyze(src), "help")).toEqual(["show"]);
  });
});

describe("V declarations", () => {
  const a = analyze([
    "module main",
    "",
    "import veb",
    "import db.sqlite as sqlite",
    "import net.http { get, post }",
    "",
    "@[table: 'players']",
    "pub struct Player {",
    "pub mut:",
    "  id   int    @[primary; sql: serial]",
    "  name string",
    "mut:",
    "  hits int = 0",
    "}",
    "",
    "pub interface Notifier {",
    "  notify(msg string) !",
    "}",
    "",
    "pub fn (mut app App) find_player(id int) ?Player {",
    "  if id <= 0 { return none }",
    "  rows := sql app.db { select from Player where id == id }",
    "  app.log(int(id).str())",
    "  return rows[0] or { none }",
    "}",
    "",
    "fn helper(a, b int, mut out []string) string {",
    "  out << fmt(a)",
    "  return $tmpl('x.html')",
    "}",
  ].join("\n"));

  it("reads functions and receiver methods, attached to their struct (a stub for one declared elsewhere)", () => {
    expect(a.functions.map((f) => [f.name, f.isExported, f.returnType])).toEqual([["helper", false, "string"]]);
    expect(a.functions[0]!.params.map((p) => `${p.name}:${p.type}`)).toEqual(["a:int", "b:int", "out:[]string"]);
    const app = a.classes.find((c) => c.name === "App")!;
    expect(app.methods.map((m) => [m.name, m.isExported, m.returnType])).toEqual([["find_player", true, "?Player"]]);
    // The receiver is the method's typed local.
    expect(app.methods[0]!.localTypes).toEqual([{ name: "app", type: "App" }]);
  });

  it("reads calls — never keywords, casts or compile-time calls", () => {
    expect(calls(a, "find_player")).toEqual(["app.log"]);
    expect(calls(a, "helper")).toEqual(["fmt"]);
  });

  it("reads structs with fields per access section, attributes and interfaces", () => {
    const player = a.classes.find((c) => c.name === "Player")!;
    expect(player.decorators).toEqual(["table: 'players'"]);
    expect(player.properties.map((p) => `${p.name}:${p.type}:${p.visibility}:${p.decorators?.join("|") ?? ""}`)).toEqual([
      "id:int:public:primary|sql: serial", "name:string:public:", "hits:int:private:",
    ]);
    const notifier = a.classes.find((c) => c.name === "Notifier")!;
    expect([notifier.kind, notifier.methods.map((m) => m.name)]).toEqual(["interface", ["notify"]]);
  });

  it("reads imports with their alias or selected names", () => {
    expect(a.imports.map((i) => `${i.source}[${i.specifiers}]`)).toEqual(["veb[veb]", "db.sqlite[sqlite]", "net.http[get,post]"]);
  });
});

describe("veb routes", () => {
  it("reads attribute routes, method lists, name routes and index — never a Context helper", () => {
    const a = analyze([
      "import veb",
      "pub struct Context { veb.Context }",
      "pub fn (mut ctx Context) not_found() veb.Result {",
      "  return ctx.text('404')",
      "}",
      "@['/players/:id'; get; post]",
      "pub fn (app &App) player(mut ctx Context, id string) veb.Result {",
      "  return ctx.json(app.find_player(id.int()))",
      "}",
      "['/legacy']",
      "pub fn (mut app App) legacy() vweb.Result {",
      "  return app.text('old')",
      "}",
      "@[post]",
      "pub fn (app &App) logout(mut ctx Context) veb.Result {",
      "  return ctx.redirect('/')",
      "}",
      "pub fn (app &App) index(mut ctx Context) veb.Result {",
      "  return $veb.html()",
      "}",
      "pub fn (app &App) about(mut ctx Context) veb.Result {",
      "  return ctx.text('about')",
      "}",
      "fn (app &App) find_player(id int) Player {",
      "  return Player{}",
      "}",
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /players/:id -> App.player", "POST /players/:id -> App.player", "GET /legacy -> App.legacy",
      "POST /logout -> App.logout", "GET / -> App.index", "GET /about -> App.about",
    ]);
  });
});

describe("V data access", () => {
  it("reads ORM statements, SQL in strings and net.http calls", () => {
    const a = analyze([
      "fn (mut app App) sync() ! {",
      "  sql app.db {",
      "    create table Car",
      "    insert car into entity.Car",
      "  }!",
      "  done := sql app.db { select count from Car where paid == true }!",
      "  sql app.db {",
      "    update Car set paid = true where id == 1",
      "    delete from Car where id == 2",
      "  }!",
      "  app.db.exec('SELECT id FROM bills WHERE total > 0')!",
      "  app.db.exec('DELETE FROM ${sql_table(t)} WHERE id = 1')!",
      "  resp := http.post_json('https://api.example.com/cars', body)!",
      "  http.fetch(url: 'https://api.example.com/ping', method: .head)!",
      "}",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name} ${d.entity ?? "-"} ${d.access ?? "-"}@${d.line}`)).toEqual([
      "database create table Car Car -@3",
      "database insert Car Car write@4",
      "database select Car Car read@6",
      "database update Car Car write@8",
      "database delete Car Car write@9",
      "database SELECT bills read@11",
      "api-call POST https://api.example.com/cars - -@13",
      "api-call HEAD https://api.example.com/ping - -@14",
    ]);
  });
});

describe("v.mod", () => {
  it("reads dependencies, URLs by their module name", async () => {
    const spec = PACKAGE_MANAGERS.find((m) => m.ecosystem === "vpm")!;
    const text = "Module {\n  name: 'shop'\n  dependencies: [\n    'markdown',\n    'nedpals.vex',\n    'https://github.com/vlang/pcre'\n  ]\n}\n";
    const ctx = { declaredIn: "v.mod", path: "v.mod", readSibling: async () => null };
    expect((await spec.manifests[0]!.parse(text, ctx)).map((p) => p.name)).toEqual(["markdown", "nedpals.vex", "pcre"]);
  });
});

describe("V line endings", () => {
  const root = resolve(__dirname, "../../../..");
  const files = globSync("test-fixtures/sample-v-app/**/*.{v,vsh}", { cwd: root });

  it("found fixture sources", () => expect(files.length).toBeGreaterThan(0));

  for (const rel of files) {
    it(`reads ${rel} with CRLF or CR line endings as with LF`, () => {
      const lf = readFileSync(resolve(root, rel), "utf-8").replace(/\r\n?/g, "\n");
      expect(analyzeAny(lf.replace(/\n/g, "\r\n"), rel)).toEqual(analyzeAny(lf, rel));
      expect(analyzeAny(lf.replace(/\n/g, "\r"), rel)).toEqual(analyzeAny(lf, rel));
    });
  }
});
