import { readFile } from "fs/promises";
import { join } from "path";
import type { FileAnalysis } from "../../../../types/analysis.js";

/**
 * Detect FILE-BASED ("auto") frontend routes — routes a build plugin generates
 * from a directory of page files instead of an explicit `routes: [...]` table,
 * so they never appear as source the AST route extractors can read.
 *
 * Supported conventions:
 *   - `unplugin-vue-router` (`vue-router/auto`): every `.vue` under `routesFolder`
 *     (default `src/pages`) is a route; `[id]`→`:id`, `[[id]]`→`:id?`,
 *     `[...all]`→catch-all, `index`→the parent path, nested dirs→nested paths.
 *   - `vite-plugin-pages`: same file→path convention, `dirs` (default `src/pages`).
 *
 * A project opts in via its Vite config (the plugin import + optional folder
 * override), which is config — not analyzed source — so this reads it from disk
 * per candidate root. Each matching page file gets a `kind:"frontend"` route
 * with `componentPath:null` pushed onto its own `FileAnalysis.routes`: the page
 * file IS the route's component, so the screen builder treats it as an inline
 * page (the file becomes the screen at the derived path).
 *
 * This is the JS/Vue ecosystem's project-level route step — it lives in the JS
 * route plugin (alongside vue-router/react-router) and is invoked once by the
 * analyzer after per-file analysis, mirroring how `reconcileProjectEntities`
 * runs each entity plugin's cross-file pass. In-memory only — per-file JSON on
 * disk is unchanged.
 *
 * Returns the number of routes added. Mutates `analyses` in place.
 */
export async function detectFileBasedRoutes(
  analyses: FileAnalysis[],
  projectRoot: string,
  roots: string[],
): Promise<number> {
  let added = 0;
  const seen = new Set<string>();
  for (const root of roots) {
    const key = root ?? "";
    if (seen.has(key)) continue;
    seen.add(key);

    const folder = await detectRoutesFolder(projectRoot, key);
    if (!folder) continue;

    const base = key ? `${normalizeSlashes(key).replace(/\/$/, "")}/` : "";
    const prefix = `${base}${folder.replace(/^\.?\/+/, "").replace(/\/+$/, "")}/`;

    for (const a of analyses) {
      const fp = normalizeSlashes(a.filePath);
      if (!fp.startsWith(prefix) || !/\.vue$/i.test(fp)) continue;
      // Don't override an explicit route already extracted for this page.
      if ((a.routes ?? []).some((r) => r.kind === "frontend")) continue;

      const path = fileToRoutePath(fp.slice(prefix.length));
      if (path == null) continue;
      (a.routes ??= []).push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler: handlerName(path),
        componentPath: null, // the page file itself is the component
        calls: [],
        middleware: [],
        line: 1,
      });
      added++;
    }
  }
  return added;
}

const VITE_CONFIG_NAMES = [
  "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];

/**
 * Inspect a root's Vite config for a file-based-routing plugin and return its
 * page directory (the convention default when the option is omitted), or null.
 */
async function detectRoutesFolder(projectRoot: string, root: string): Promise<string | null> {
  for (const name of VITE_CONFIG_NAMES) {
    let text: string;
    try {
      text = await readFile(join(projectRoot, root, name), "utf-8");
    } catch {
      continue; // no such config file
    }
    if (/unplugin-vue-router/.test(text)) {
      // `routesFolder: 'src/routes'` (a string form; arrays/objects fall back).
      const m = /routesFolder\s*:\s*['"]([^'"]+)['"]/.exec(text);
      return m ? m[1] : "src/pages";
    }
    if (/vite-plugin-pages/.test(text)) {
      const m = /(?:dirs|pagesDir)\s*:\s*['"]([^'"]+)['"]/.exec(text);
      return m ? m[1] : "src/pages";
    }
  }
  return null;
}

/**
 * Map a page file path (relative to the routes folder) to its route path using
 * the unplugin-vue-router / vite-plugin-pages convention. Returns null if the
 * file is not a routable page.
 */
export function fileToRoutePath(relative: string): string | null {
  const noExt = relative.replace(/\.vue$/i, "");
  const out: string[] = [];
  for (const seg of noExt.split("/")) {
    if (seg === "index" || seg === "") continue; // index → the parent's path
    out.push(convertSegment(seg));
  }
  const path = `/${out.join("/")}`;
  return path === "/" ? "/" : path.replace(/\/+$/, "") || "/";
}

/** Convert one path segment's dynamic-parameter tokens to vue-router syntax. */
function convertSegment(seg: string): string {
  return seg
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, ":$1*") // [[...all]] optional catch-all
    .replace(/\[\.\.\.([^\]]+)\]/g, ":$1+") //     [...all]  catch-all
    .replace(/\[\[([^\]]+)\]\]/g, ":$1?") //       [[id]]    optional param
    .replace(/\[([^\]]+)\]/g, ":$1"); //           [id]      param
}

/** A readable handler/name for the route: its last meaningful segment. */
function handlerName(path: string): string {
  const segs = path.split("/").filter(Boolean);
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]!.replace(/[:*+?]/g, "");
    if (s) return s;
  }
  return "index";
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/");
}
