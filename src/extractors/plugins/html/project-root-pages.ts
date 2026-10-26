import type { FileAnalysis } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { pageRoutePath } from "./index.js";
import { STATIC_MOUNT_FACT, type StaticMount } from "../shared/static-mounts.js";

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
  languages: ["html", "javascript", "typescript"],
  priority: 30,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    // Directories a server mounts as static files: their pages are served from the mount.
    const mounts: Array<{ dir: string; prefix: string }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== STATIC_MOUNT_FACT) continue;
        const m = f.data as StaticMount;
        const parts = (a.filePath.includes("/") ? a.filePath.slice(0, a.filePath.lastIndexOf("/")).split("/") : []);
        for (const seg of m.dir.split("/")) {
          if (seg === "..") parts.pop();
          else if (seg && seg !== ".") parts.push(seg);
        }
        mounts.push({ dir: parts.join("/"), prefix: m.prefix.replace(/\/+$/, "") });
      }
    }
    const served = new Map<string, "vite" | "bundler" | null>();
    for (const a of analyses) {
      if (a.language !== "html") continue;
      const mount = mounts.find((m) => m.dir === "" || a.filePath.startsWith(`${m.dir}/`));
      if (mount) {
        const own = pageRoutePath(a.filePath);
        const path = `${mount.prefix}${pageRoutePath(mount.dir ? a.filePath.slice(mount.dir.length + 1) : a.filePath)}`;
        a.routes = a.routes.map((r) => (r.kind === "frontend" && r.path === own && r.path !== path ? { ...r, path } : r));
        continue;
      }
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
