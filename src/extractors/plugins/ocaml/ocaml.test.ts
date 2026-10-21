import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "bin/main.ml"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "ml-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "ocaml" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "ml-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("OCaml modules, functions and imports", () => {
  it("reads the file as a module, nested modules, types and functions", async () => {
    const a = await analyze([
      "open Lwt.Syntax",
      "type car = { id : int; total : float }",
      "type status = Open | Closed",
      "module type REPO = sig val find : int -> car Lwt.t end",
      "module Cache = struct let get key = Hashtbl.find_opt table key end",
      "let find_car ~id = Db.find id |> Lwt.map Option.get",
      "let close_car (repo : Repo.t) ?(force = false) id =",
      "  if id > 0 && not force then Repo.save repo id else Lwt.return_unit",
      "let handler = fun req -> Db.load req",
      "let port = 8080",
      "let () = Dream.run (fun _ -> find_car ~id:1)",
    ].join("\n"), "lib/car_repo.ml");
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.methods.map((m) => m.name), c.properties.map((p) => p.name)])).toEqual([
      ["Car_repo", "class", ["find_car", "close_car", "handler"], []],
      ["car", "class", [], ["id", "total"]],
      ["status", "enum", [], []],
      ["REPO", "interface", ["find"], []],
      ["Cache", "class", ["get"], []],
    ]);
    const close = a.classes[0]!.methods[1]!;
    expect(close.params).toEqual([
      { name: "repo", type: "Repo.t", defaultValue: null },
      { name: "force", type: null, defaultValue: "false" },
      { name: "id", type: null, defaultValue: null },
    ]);
    expect(close.calls.map((c) => c.name)).toEqual(["not", "Repo.save"]);
    expect(a.classes[0]!.methods[0]!.calls.map((c) => c.name)).toEqual(["Db.find", "Lwt.map"]);
    // The module's own load-time code; the lambda runs later.
    expect(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["<setup>", ["Dream.run"]]]);
    expect(a.imports.map((i) => i.source)).toEqual(["Lwt", "Db", "Repo", "Dream"]);
  });
});

describe("OCaml routes and data access", () => {
  it("reads Dream routes under scopes and Opium routes", async () => {
    const a = await analyze([
      "let () =",
      "  Dream.run @@ Dream.router [",
      '    Dream.get "/api/cars/:id" (fun req -> Cars.find (Dream.param req "id"));',
      '    Dream.scope "/admin" [ Auth.require ] [ Dream.post "/cars/:id/close" Cars.close ];',
      "  ]",
      'let app = App.empty |> App.get "/health" health |> App.run_command',
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /api/cars/{id} -> null [Cars.find,Dream.param]",
      "POST /admin/cars/{id}/close -> Cars.close []",
      "GET /health -> health []",
    ]);
  });

  it("reads SQL in strings and ppx_rapper blocks, and HTTP client calls", async () => {
    const a = await analyze([
      'let all = Caqti_request.Infix.(T.unit ->* T.string) "SELECT name FROM drivers"',
      "let one = [%rapper get_one {sql| SELECT @int{id}, @string{status} FROM cars WHERE id = %int{id} |sql}]",
      'let crm id = Cohttp_lwt_unix.Client.get (Uri.of_string "https://crm.example.com/v2/drivers")',
      'let msg = "Select a file from the list"',
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}@${d.line}`)).toEqual([
      "database SELECT drivers@1",
      "database SELECT cars@2",
      "api-call GET https://crm.example.com/v2/drivers@3",
    ]);
  });
});

describe("OCaml packages", () => {
  it("a [%rapper …] binding is a function, applied to () or not", async () => {
    const a = await analyze([
      "let open_cars =",
      "  [%rapper get_many {sql| SELECT @int{id} FROM cars |sql} record_out] ()",
      "let one = [%rapper get_one {sql| SELECT @int{id} FROM cars WHERE id = %int{id} |sql}]",
      "let limit = 10",
    ].join("\n"), "lib/db.ml");
    expect(a.classes[0]!.methods.map((m) => m.name)).toEqual(["open_cars", "one"]);
  });

  it("reads opam and dune-project dependencies", async () => {
    const { opamPackageManager } = await import("./package-manifests.js");
    const opam = 'opam-version: "2.0"\ndepends: [\n  "ocaml" {>= "4.14"}\n  "dream" {>= "1.0.0~alpha5"}\n  "caqti-lwt"\n  "alcotest" {with-test}\n]\n';
    const dune = "(lang dune 3.0)\n(package\n (name shop)\n (depends\n  (ocaml (>= 4.14))\n  dream\n  (caqti (>= 2.0))\n  (alcotest :with-test)))\n";
    const fmt = (ps: unknown) => (ps as Array<{ name: string; version: string | null; scope: string }>).map((p) => `${p.name}@${p.version} ${p.scope}`);
    expect(fmt(opamPackageManager.manifests[0]!.parse(opam, { declaredIn: "shop.opam" } as never))).toEqual([
      "dream@1.0.0~alpha5 prod", "caqti-lwt@null prod", "alcotest@null dev",
    ]);
    expect(fmt(opamPackageManager.manifests[1]!.parse(dune, { declaredIn: "dune-project" } as never))).toEqual([
      "dream@null prod", "caqti@2.0 prod", "alcotest@null dev",
    ]);
  });
});
