import { describe, it, expect } from "vitest";
import "../extractors/registry.js";
import { parseSource } from "../parsers/parser-manager.js";
import { assessCoverage, parseErrorsOf } from "./coverage.js";
import { createEmptyAnalysis, type ExternalPackage, type FileAnalysis, type FunctionInfo } from "../types/analysis.js";

describe("parseErrorsOf", () => {
  it("is null for a clean file, and measures what a broken one leaves unread", async () => {
    const clean = "export function a(x: number) { return x + 1; }\n";
    expect(parseErrorsOf(await parseSource(clean, "typescript" as any, "a.ts"), clean.length)).toBeNull();
    const broken = "export function a(x: number) { return x + ; }\nconst ok = 1;\nfunction b( {{{ \n";
    const e = parseErrorsOf(await parseSource(broken, "typescript" as any, "b.ts"), broken.length)!;
    expect(e.nodes + e.missing).toBeGreaterThan(0);
    expect(e.ratio).toBeGreaterThan(0);
    expect(e.ratio).toBeLessThan(1);
  });
});

describe("assessCoverage", () => {
  const fa = (filePath: string, imports: string[], parseErrors?: FileAnalysis["parseErrors"]) =>
    ({ filePath, imports: imports.map((source) => ({ source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line: 1 })), ...(parseErrors ? { parseErrors } : {}) }) as unknown as FileAnalysis;
  const pkg = (name: string, category: string, declaredIn: string, scope = "prod"): ExternalPackage => ({ name, category, declaredIn, scope, version: "1", ecosystem: "npm", used: true }) as unknown as ExternalPackage;

  it("counts relative imports that resolve, lists the worst files, and names frameworks that yielded nothing", () => {
    const c = assessCoverage({
      analyses: [fa("api/server.ts", ["./routes", "./gone", "express"]), fa("web/App.tsx", ["./Page"], { nodes: 2, missing: 0, ratio: 0.25 })],
      resolveModule: (_from, spec) => (spec === "./gone" ? null : "x"),
      packages: [pkg("express", "framework", "api/package.json"), pkg("react", "frontend", "web/package.json"), pkg("vite", "frontend", "web/package.json", "dev")],
      subProjects: [{ id: "api", root: "api" }, { id: "web", root: "web" }] as any,
      routeMap: [],
      screens: [{ name: "App", filePath: "web/App.tsx" }] as any,
      fileProjects: { "api/server.ts": "api", "web/App.tsx": "web" },
    });
    expect(c.imports).toEqual({ local: 3, resolved: 2, worst: [{ file: "api/server.ts", unresolved: 1, total: 2 }] });
    expect(c.parseErrors).toEqual({ files: 1, worst: [{ file: "web/App.tsx", ratio: 0.25, nodes: 2 }] });
    expect(c.gaps).toEqual([{ project: "api", kind: "routes", dependencies: ["express"] }]);
  });

  it("counts the handler-shaped functions where routes are missing, and names the code read by pattern matching", () => {
    const fn = (name: string, line: number, params: Array<[string, string | null]>) =>
      ({ name, line, params: params.map(([n, type]) => ({ name: n, type, defaultValue: null })) }) as unknown as FunctionInfo;
    const go = { ...createEmptyAnalysis("api/orders.go", "go"), functions: [fn("ListOrders", 12, [["w", "http.ResponseWriter"], ["r", "*http.Request"]]), fn("total", 30, [["xs", "[]int"]])] };
    const js = { ...createEmptyAnalysis("api/legacy.js", "javascript"), functions: [fn("handle", 3, [["req", null], ["res", null]])] };
    const test = { ...createEmptyAnalysis("api/orders_test.go", "go"), functions: [fn("TestList", 5, [["t", "*testing.T"], ["r", "*http.Request"]])] };
    const c = assessCoverage({
      analyses: [go, js, test],
      resolveModule: () => "x",
      packages: [pkg("github.com/go-chi/chi", "framework", "api/go.mod")],
      subProjects: [{ id: "api", root: "api" }] as any,
      routeMap: [],
      screens: [],
      fileProjects: { "api/orders.go": "api", "api/legacy.js": "api", "api/orders_test.go": "api" },
    });
    expect(c.gaps).toEqual([{ project: "api", kind: "routes", dependencies: ["github.com/go-chi/chi"], handlers: { count: 2, examples: ["api/orders.go:12 ListOrders", "api/legacy.js:3 handle"] } }]);
    expect(c.approximate).toEqual({ files: 2, languages: [{ language: "go", files: 2 }] });
  });
});
