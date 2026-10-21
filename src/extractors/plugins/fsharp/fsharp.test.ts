import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "src/App.fs"): Promise<FileAnalysis | null> {
  const root = await mkdtemp(join(tmpdir(), "fs-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "fsharp" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "fs-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result?.analysis ?? null;
}

describe("F# functions and types", () => {
  it("reads module functions, computed values and types — not constants or locals", async () => {
    const a = (await analyze([
      "module Shop.Api",
      "open Giraffe",
      "let port = 8080",
      "let private helper (x: int) = x + 1",
      "let getCar (id: int) : HttpHandler =",
      "    fun next ctx ->",
      "        let repo = ctx.GetService<ICarRepo>()",
      "        if id > 0 && id < 100 then json (repo.Find id) next ctx else skipPipeline",
      "let handler : HttpHandler = fun next ctx -> text \"ok\" next ctx",
      "type Car = { Id: int; Total: decimal }",
      "type IRepo =",
      "    abstract member Find: int -> Car",
      "type SqlRepo(conn: IDbConnection) =",
      "    inherit BaseRepo(conn)",
      "    member this.Find(id: int) = conn.Query<Car>(\"x\") |> Seq.head",
      "    interface IRepo with",
      "        member this.Find id = this.Find(id)",
      "module Inner =",
      "    let nested () = helper 1",
    ].join("\n")))!;
    expect(a.functions.map((f) => f.name)).toEqual(["helper", "getCar", "handler", "nested"]);
    const getCar = a.functions.find((f) => f.name === "getCar")!;
    expect(getCar.params).toEqual([{ name: "id", type: "int", defaultValue: null }]);
    // `json` is shared call noise (NOISE_CALLS — `res.json()`), dropped by design.
    expect(getCar.calls.map((c) => c.name)).toEqual(["ctx.GetService", "repo.Find"]);
    expect(a.complexities?.find((c) => c.functionName === "getCar")?.complexity).toBe(3);
    const classes = Object.fromEntries(a.classes.map((c) => [c.name, c]));
    expect(classes.Car!.properties.map((p) => p.name)).toEqual(["Id", "Total"]);
    expect(classes.IRepo!.kind).toBe("interface");
    expect([classes.SqlRepo!.extends, classes.SqlRepo!.implements]).toEqual(["BaseRepo", ["IRepo"]]);
    expect(classes.SqlRepo!.methods.map((m) => m.name)).toEqual(["SqlRepo", "Find", "Find"]);
    expect(classes.SqlRepo!.methods[0]!.params).toEqual([{ name: "conn", type: "IDbConnection", defaultValue: null }]);
  });

  it("keeps a module's own statements in <setup>, not its functions' calls", async () => {
    const a = (await analyze("module M\nlet run () = work ()\nprintfn \"start\"\nrun ()", "src/M.fsx"))!;
    expect(a.functions.find((f) => f.name === "<setup>")?.calls.map((c) => c.name)).toEqual(["printfn", "run"]);
  });
});

describe("F# routes", () => {
  it("reads Giraffe chains, routef, subRoute and endpoint routing", async () => {
    const a = (await analyze([
      "module Shop.Program",
      "open Giraffe",
      "let webApp =",
      "    choose [",
      "        GET >=> route \"/api/health\" >=> text \"ok\"",
      "        GET >=> routef \"/api/cars/%i\" getCar",
      "        POST >=> route \"/api/cars\" >=> createCar",
      "        subRoute \"/admin\" (choose [ GET >=> route \"/stats\" >=> stats ])",
      "    ]",
      "let endpoints = [ GET [ route \"/ping\" pong ]; subRoute \"/v2\" [ POST [ routef \"/items/%s\" addItem ] ] ]",
    ].join("\n")))!;
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "GET /api/health -> text",
      "GET /api/cars/{int} -> getCar",
      "POST /api/cars -> createCar",
      "GET /admin/stats -> stats",
      "GET /ping -> pong",
      "POST /v2/items/{string} -> addItem",
    ]);
  });

  it("reads Saturn routers and minimal APIs", async () => {
    const saturn = (await analyze("module R\nopen Saturn\nlet api = router {\n    get \"/players\" listPlayers\n    postf \"/players/%i\" updatePlayer\n}"))!;
    expect(saturn.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual(["GET /players -> listPlayers", "POST /players/{int} -> updatePlayer"]);
    const minimal = (await analyze("module P\nlet main args =\n    let app = WebApplication.Create()\n    app.MapGet(\"/hello\", Func<string>(hello)) |> ignore\n    0"))!;
    expect(minimal.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual(["GET /hello -> hello"]);
  });
});

describe("F# data access and imports", () => {
  it("reads SQL in strings and HttpClient calls", async () => {
    const a = (await analyze([
      "module D",
      "let find (conn: IDbConnection) id = conn.QuerySingle<Car>(\"SELECT Id FROM Cars WHERE Id = @id\", {| id = id |})",
      "let save (conn: IDbConnection) o =",
      "    conn.Execute(\"\"\"",
      "        INSERT INTO Cars (Total)",
      "        VALUES (@Total)\"\"\", o)",
      "let notify (client: HttpClient) = client.PostAsJsonAsync(\"https://billing.example.com/api/bills\", 1)",
      "let label = \"Select a file from the list\"",
    ].join("\n")))!;
    expect(a.dataSources.map((d) => `${d.kind} ${d.name} ${d.entity ?? ""}@${d.line}`)).toEqual([
      "database SELECT Cars@2",
      "database INSERT INTO Cars@4",
      "api-call POST https://billing.example.com/api/bills @7",
    ]);
  });

  it("reads opens and script directives", async () => {
    const a = (await analyze("#load \"helpers.fsx\"\n#r \"nuget: Dapper, 2.1.0\"\nopen System.Data\nopen Shop.Domain\nlet x = 1", "build.fsx"))!;
    expect(a.imports.map((i) => i.source)).toEqual(["./helpers.fsx", "Dapper", "System.Data", "Shop.Domain"]);
  });

  it("skips a GLSL fragment shader", async () => {
    expect(await analyze("#version 330 core\nout vec4 color;\nvoid main() { color = vec4(1.0); }", "shaders/glow.fs")).toBeNull();
  });
});
