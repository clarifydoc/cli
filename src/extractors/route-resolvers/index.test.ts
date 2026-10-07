import { describe, it, expect } from "vitest";
import { reconcileProjectRoutes } from "./index.js";
import type { RouteResolver } from "./base.js";
import type { FileAnalysis, RouteInfo } from "../../types/analysis.js";
import type { ProjectContext } from "../../types/project.js";

const route = (path: string, httpMethod = "GET"): RouteInfo => ({
  path, httpMethod, kind: "api", handler: null, calls: [], middleware: [], line: 1,
});
const file = (filePath: string, language: string, routes: RouteInfo[]): FileAnalysis =>
  ({ filePath, language, routes } as unknown as FileAnalysis);
const ctx = {} as ProjectContext;

describe("reconcileProjectRoutes", () => {
  it("stamps resolvedBy on rows a resolver created or replaced, and only those", () => {
    const kept = route("/kept");
    const a = file("a.py", "python", [kept, route("/old")]);
    const resolver: RouteResolver = {
      id: "prefixer",
      languages: ["python"],
      priority: 10,
      resolve: (analyses) => {
        for (const x of analyses) x.routes = x.routes.map((r) => (r.path === "/old" ? { ...r, path: "/api/old" } : r));
      },
    };
    expect(reconcileProjectRoutes([a], ctx, [resolver])).toBe(1);
    expect(a.routes[0]).toBe(kept);
    expect(kept.resolvedBy).toBeUndefined();
    expect(a.routes[1]).toMatchObject({ path: "/api/old", resolvedBy: "prefixer" });
  });

  it("gives each resolver only its languages, in priority order", () => {
    const order: string[] = [];
    const seen: Record<string, string[]> = {};
    const mk = (id: string, languages: string[], priority: number): RouteResolver => ({
      id,
      languages: languages as RouteResolver["languages"],
      priority,
      resolve: (analyses) => {
        order.push(id);
        seen[id] = analyses.map((x) => x.filePath);
      },
    });
    const files = [file("a.py", "python", []), file("b.cs", "csharp", [])];
    reconcileProjectRoutes(files, ctx, [mk("late", ["csharp"], 20), mk("early", ["python"], 10), mk("none", ["go"], 0)]);
    expect(order).toEqual(["early", "late"]);
    expect(seen).toEqual({ early: ["a.py"], late: ["b.cs"] });
  });

  it("is a no-op with no resolvers", () => {
    expect(reconcileProjectRoutes([file("a.py", "python", [route("/x")])], ctx, [])).toBe(0);
  });
});
