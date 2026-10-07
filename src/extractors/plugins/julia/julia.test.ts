import { describe, it, expect } from "vitest";
import { analyzeFile } from "../../../core/file-analyzer.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { FileAnalysis } from "../../../types/analysis.js";

/** Through the real per-file pipeline (tree-sitter parse + every extractor). */
async function analyze(src: string, rel = "src/App.jl"): Promise<FileAnalysis> {
  const root = await mkdtemp(join(tmpdir(), "jl-"));
  await mkdir(join(root, dirname(rel)), { recursive: true });
  await writeFile(join(root, rel), src);
  const result = await analyzeFile({
    file: { absolutePath: join(root, rel), relativePath: rel, language: "julia" },
    frameworkIds: [],
    projectId: "root",
    outputOpts: { outputDir: await mkdtemp(join(tmpdir(), "jl-out-")), pretty: false },
    verbose: false,
    projectRoot: root,
    tsconfigAliases: new Map(),
  } as never);
  return result!.analysis;
}

describe("Julia functions, types and imports", () => {
  it("reads long and short functions, macros, structs and abstract types", async () => {
    const a = await analyze([
      "module Shop",
      "using LibPQ, Genie.Router: route",
      'include("db.jl")',
      "abstract type Repo end",
      "mutable struct PgRepo <: Repo",
      "    conn",
      "    table::String",
      "end",
      "function find(repo::PgRepo, id::Int=1; strict=false)::Order",
      "    if id > 0 && strict",
      "        load(repo, id)",
      "    end",
      "    open(path) do f",
      "        parse_row(f)",
      "    end",
      "end",
      "total(o::Order) = o.total * rate()",
      "macro trace(ex)",
      "    esc(ex)",
      "end",
      "start()",
      "end",
    ].join("\n"));
    const fns = Object.fromEntries(a.functions.map((f) => [f.name, f]));
    expect(Object.keys(fns)).toEqual(["<setup>", "find", "total", "@trace"]);
    expect(fns["<setup>"]!.calls.map((c) => c.name)).toEqual(["start"]);
    expect(fns.find!.params).toEqual([
      { name: "repo", type: "PgRepo", defaultValue: null },
      { name: "id", type: "Int", defaultValue: "1" },
      { name: "strict", type: null, defaultValue: "false" },
    ]);
    expect(fns.find!.returnType).toBe("Order");
    expect(fns.find!.calls.map((c) => c.name)).toEqual(["load", "open", "parse_row"]);
    expect(fns.total!.calls.map((c) => c.name)).toEqual(["rate"]);
    expect(a.complexities?.find((c) => c.functionName === "find")?.complexity).toBe(3);
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.extends, c.properties.map((p) => p.name)])).toEqual([
      ["Repo", "interface", null, []], ["PgRepo", "class", "Repo", ["conn", "table"]],
    ]);
    expect(a.imports.map((i) => i.source)).toEqual(["LibPQ", "Genie.Router", "./db.jl"]);
  });
});

describe("Julia routes and data access", () => {
  it("reads Genie, Oxygen and HTTP.jl routes", async () => {
    const a = await analyze([
      'route("/api/orders") do',
      "    json(open_orders())",
      "end",
      'route("/api/orders/:id::Int", method = POST) do',
      "    close_order(payload(:id))",
      "end",
      'route("/api/customers/:id", customer_handler)',
      '@get "/health" function(req)',
      '    "ok"',
      "end",
      '@route ["GET", "POST"] "/echo" echo',
      'HTTP.register!(router, "DELETE", "/api/orders/{id}", delete_order)',
    ].join("\n"));
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler} [${r.calls.map((c) => c.name)}]`)).toEqual([
      "GET /api/orders -> null [open_orders]",
      "POST /api/orders/{id} -> null [close_order,payload]",
      "GET /api/customers/{id} -> customer_handler []",
      "GET /health -> null []",
      "GET /echo -> echo []",
      "POST /echo -> echo []",
      "DELETE /api/orders/{id} -> delete_order []",
    ]);
    // Registering a route runs at load; its do-block runs per request.
    expect(a.functions.find((f) => f.name === "<setup>")?.calls.map((c) => c.name)).toEqual(["route", "HTTP.register!"]);
  });

  it("reads SQL in strings and HTTP calls, interpolations as holes", async () => {
    const a = await analyze([
      "f(conn, id) = LibPQ.execute(conn, \"DELETE FROM sessions WHERE id = $id\")",
      "g(id) = HTTP.get(\"https://crm.example.com/v2/customers/$(id)\")",
      "h() = HTTP.request(\"POST\", \"/api/events\")",
      "msg = \"Select a file from the list\"",
    ].join("\n"));
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}`)).toEqual([
      "database DELETE FROM sessions",
      "api-call GET https://crm.example.com/v2/customers/{id}",
      "api-call POST /api/events",
    ]);
  });
});
