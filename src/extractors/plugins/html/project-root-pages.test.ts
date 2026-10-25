import { describe, it, expect } from "vitest";
import { htmlProjectRootPages } from "./project-root-pages.js";
import type { FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

const page = (filePath: string, projectId: string, path: string): FileAnalysis =>
  ({ filePath, projectId, language: "html", routes: [{ path, httpMethod: null, kind: "frontend", handler: null, calls: [], middleware: [], line: 1, componentPath: null } as RouteInfo] }) as unknown as FileAnalysis;

function run(analyses: FileAnalysis[], files: string[], roots: Record<string, string>): string[] {
  const known = new Set([...files, ...analyses.map((a) => a.filePath)]);
  const ctx = {
    fileOf: (p: string) => (known.has(p) ? ({ filePath: p } as FileAnalysis) : undefined),
    projectRootOf: (id: string) => roots[id] ?? null,
  } as unknown as ProjectContext;
  htmlProjectRootPages.resolve(analyses, ctx);
  return analyses.map((a) => a.routes[0]!.path);
}

describe("pages of a sub-project with its own dev server", () => {
  it("serves a Vite project's pages from its root", () => {
    const paths = run(
      [page("garage-ui/index.html", "garage-ui", "/garage-ui/"), page("garage-ui/cars/list.html", "garage-ui", "/garage-ui/cars/list.html")],
      ["garage-ui/vite.config.ts"],
      { "garage-ui": "garage-ui" },
    );
    expect(paths).toEqual(["/", "/cars/list.html"]);
  });

  it("serves another bundler's entry page at / and leaves its other pages", () => {
    const paths = run(
      [page("league/public/index.html", "league", "/league/public/"), page("league/docs/notes.html", "league", "/league/docs/notes.html")],
      ["league/webpack.config.js"],
      { league: "league" },
    );
    expect(paths).toEqual(["/", "/league/docs/notes.html"]);
  });

  it("keeps a static tree's paths relative to the analysis root", () => {
    expect(run([page("site/index.html", "site", "/site/")], [], { site: "site" })).toEqual(["/site/"]);
    expect(run([page("index.html", "root", "/")], ["vite.config.ts"], { root: "" })).toEqual(["/"]);
  });
});
