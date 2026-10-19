import { describe, it, expect } from "vitest";
import "../extractors/registry.js";
import { parseSource } from "../parsers/parser-manager.js";
import { assessCoverage, parseErrorsOf } from "./coverage.js";
import type { ExternalPackage, FileAnalysis } from "../types/analysis.js";

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
});
