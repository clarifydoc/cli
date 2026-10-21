import { describe, it, expect } from "vitest";
import { extractWithRegex } from "../../../core/regex-extractor.js";
import type { FileAnalysis } from "../../../types/analysis.js";

const analyze = (src: string, path = "shop/service.mojo"): FileAnalysis => extractWithRegex(src, path, "mojo");

describe("Mojo functions, structs and imports", () => {
  const a = analyze([
    "from collections import List, Dict",
    "from .db import find_car, close_car",
    "import math",
    "",
    "trait Repo:",
    "    fn find(self, id: Int) raises -> Car: ...",
    "",
    "@value",
    "struct CarService(Repo, Copyable):",
    "    var name: String",
    "    var count: Int = 0",
    "",
    "    fn __init__(out self, owned name: String):",
    "        self.name = name^",
    "",
    "    fn close(mut self, id: Int, force: Bool = False) raises -> Bool:",
    "        var car = find_car(id)",
    "        if car.total > 0 and not force:",
    "            close_car(id)",
    "        return self.audit(car)",
    "",
    "    fn audit(self, car: Car) -> Bool:",
    "        return True",
    "",
    "def main():",
    "    var svc = CarService(\"cars\")",
    "    print(svc.audit(1))",
  ].join("\n"));

  it("reads structs with their traits and fields, and traits", () => {
    expect(a.classes.map((c) => [c.name, c.kind ?? "class", c.implements, c.properties.map((p) => `${p.name}:${p.type}`), c.methods.map((m) => m.name)])).toEqual([
      ["Repo", "interface", [], [], ["find"]],
      ["CarService", "class", ["Repo", "Copyable"], ["name:String", "count:Int"], ["__init__", "close", "audit"]],
    ]);
    expect(a.classes[1]!.decorators).toEqual(["value"]);
  });

  it("reads conventions, typed params and return types", () => {
    const close = a.classes[1]!.methods.find((m) => m.name === "close")!;
    expect(close.params).toEqual([
      { name: "id", type: "Int", defaultValue: null },
      { name: "force", type: "Bool", defaultValue: "False" },
    ]);
    expect(close.returnType).toBe("Bool");
    expect(close.calls.map((c) => c.name)).toEqual(["find_car", "close_car", "self.audit"]);
    expect(a.classes[1]!.methods[0]!.params).toEqual([{ name: "name", type: "String", defaultValue: null }]);
    expect(a.functions.map((f) => [f.name, f.calls.map((c) => c.name)])).toEqual([["main", ["CarService", "svc.audit"]]]);
    expect(a.functions[0]!.localTypes).toEqual([{ name: "svc", type: "CarService" }]);
  });

  it("reads imports, relative ones as paths", () => {
    expect(a.imports.map((i) => [i.source, i.specifiers])).toEqual([
      ["collections", ["List", "Dict"]], ["./db", ["find_car", "close_car"]], ["math", ["math"]],
    ]);
  });
});

describe("Mojo routes and data access", () => {
  it("reads lightbug_http path branches, SQL and requests through Python interop", () => {
    const a = analyze([
      "from lightbug_http import HTTPService, HTTPRequest, HTTPResponse, OK, NotFound",
      "from python import Python",
      "",
      "@value",
      "struct Shop(HTTPService):",
      "    fn func(mut self, req: HTTPRequest) raises -> HTTPResponse:",
      "        var p = req.uri.path",
      "        if p == \"/api/cars\":",
      "            return OK(list_cars())",
      "        elif p == \"/api/cars/close\" and req.method == \"POST\":",
      "            return OK(close_all())",
      "        return NotFound(p)",
      "",
      "fn close_all() raises -> String:",
      "    var requests = Python.import_module(\"requests\")",
      "    _ = requests.post(\"https://crm.example.com/v2/cars/closed\")",
      "    return db_exec(\"UPDATE cars SET status = 'closed'\")",
    ].join("\n"), "shop/main.mojo");
    expect(a.routes.map((r) => `${r.httpMethod} ${r.path} -> ${r.handler}`)).toEqual([
      "null /api/cars -> Shop.func",
      "POST /api/cars/close -> Shop.func",
    ]);
    expect(a.dataSources.map((d) => `${d.kind} ${d.name}${d.entity ? ` ${d.entity}` : ""}`)).toEqual([
      "api-call POST https://crm.example.com/v2/cars/closed",
      "database UPDATE cars",
    ]);
  });

  it("reads pixi / mojoproject dependencies", async () => {
    const { condaPackageManager } = await import("./package-manifests.js");
    const toml = '[project]\nname = "shop"\n\n[dependencies]\nmax = ">=24.5,<25"\nlightbug_http = { version = "0.1.9" }\npython = ">=3.11"\n\n[feature.test.dependencies]\npytest = "*"\n';
    const pkgs = condaPackageManager.manifests[0]!.parse(toml, { declaredIn: "mojoproject.toml" } as never) as Array<{ name: string; version: string | null; scope: string }>;
    expect(pkgs.map((p) => `${p.name}@${p.version} ${p.scope}`)).toEqual(["max@>=24.5,<25 prod", "lightbug_http@0.1.9 prod", "pytest@* dev"]);
  });
});
