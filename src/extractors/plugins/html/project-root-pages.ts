import type { FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { pageRoutePath } from "./index.js";

/**
 * A page of a sub-project its own dev server or bundler serves is at the path it has inside that
 * project, not inside the analysis root: `webview/index.html` of a Vite project in `webview/` is
 * `/`, not `/webview/`. Vite serves every page relative to its root, so all of that project's
 * pages move; another bundler (webpack, Rspack, Rsbuild, Rollup) emits the entry `index.html` —
 * at the project root, or in `public/` or `src/` — as `/`. A plain static tree keeps the path
 * relative to the analysis root.
 */

const CONFIG_EXTENSIONS = ["ts", "js", "mjs", "mts", "cjs", "cts"];
const VITE_CONFIGS = CONFIG_EXTENSIONS.map((e) => `vite.config.${e}`);
const OTHER_BUNDLER_CONFIGS = ["webpack", "rspack", "rsbuild", "rollup"].flatMap((b) => CONFIG_EXTENSIONS.map((e) => `${b}.config.${e}`));
const ENTRY_PAGES = new Set(["index.html", "public/index.html", "src/index.html"]);

function hasAny(ctx: ProjectContext, root: string, names: readonly string[]): boolean {
  return names.some((n) => !!ctx.fileOf(`${root}/${n}`));
}

export const htmlProjectRootPages: RouteResolver = {
  id: "html-project-root",
  languages: ["html"],
  priority: 30,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const served = new Map<string, "vite" | "bundler" | null>();
    for (const a of analyses) {
      const root = a.projectId ? ctx.projectRootOf?.(a.projectId) : null;
      if (!root || !a.filePath.startsWith(`${root}/`)) continue;
      let kind = served.get(root);
      if (kind === undefined) {
        kind = hasAny(ctx, root, VITE_CONFIGS) ? "vite" : hasAny(ctx, root, OTHER_BUNDLER_CONFIGS) ? "bundler" : null;
        served.set(root, kind);
      }
      if (!kind) continue;
      const inProject = a.filePath.slice(root.length + 1);
      if (kind === "bundler" && !ENTRY_PAGES.has(inProject.toLowerCase())) continue;
      const own = pageRoutePath(a.filePath);
      const path = kind === "vite" ? pageRoutePath(inProject) : "/";
      a.routes = a.routes.map((r) => (r.kind === "frontend" && r.path === own && r.path !== path ? { ...r, path } : r));
    }
  },
};
