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

    const folders = await detectRoutesFolders(projectRoot, key);
    if (folders.length === 0) continue;

    const base = key ? `${normalizeSlashes(key).replace(/\/$/, "")}/` : "";
    for (const { folder, named } of folders) {
    const prefix = `${base}${folder.replace(/^\.?\/+/, "").replace(/\/+$/, "")}/`;

    for (const a of analyses) {
      const fp = normalizeSlashes(a.filePath);
      if (!fp.startsWith(prefix) || !PAGE_FILE_RE.test(fp)) continue;
      // Don't override an explicit route already extracted for this page.
      if ((a.routes ?? []).some((r) => r.kind === "frontend")) continue;

      const path = fileToRoutePath(fp.slice(prefix.length));
      if (path == null) continue;
      (a.routes ??= []).push({
        path,
        httpMethod: null,
        kind: "frontend",
        handler: handlerName(path),
        ...(named ? { routeName: fileToRouteName(fp.slice(prefix.length)) } : {}),
        componentPath: null, // the page file itself is the component
        calls: [],
        middleware: [],
        line: 1,
      });
      added++;
    }
    }
  }
  return added;
}

/** What a routes folder may hold as a page: Vue SFCs, JSX/TSX pages, Markdown pages (vite-plugin-pages). */
const PAGE_FILE_RE = /\.(?:vue|tsx|jsx|md)$/i;

const VITE_CONFIG_NAMES = [
  "vite.config.ts", "vite.config.mts", "vite.config.cts",
  "vite.config.js", "vite.config.mjs", "vite.config.cjs",
];

/**
 * Inspect a root's Vite config for the file-based-routing plugins and return
 * their page directories: unplugin-vue-router (`VueRouter({ routesFolder })`,
 * imported from `unplugin-vue-router/vite` or `vue-router/vite`) and
 * vite-plugin-pages (`Pages({ dirs })`, a string or an array). The convention
 * default `src/pages` applies when the option is omitted. Empty when no such
 * plugin is configured.
 */
async function detectRoutesFolders(projectRoot: string, root: string): Promise<Array<{ folder: string; named: boolean }>> {
  for (const name of VITE_CONFIG_NAMES) {
    let text: string;
    try {
      text = await readFile(join(projectRoot, root, name), "utf-8");
    } catch {
      continue; // no such config file
    }
    const folders: Array<{ folder: string; named: boolean }> = [];
    const router = /\bVueRouter\s*\(\s*(?:\{([\s\S]*?)\})?\s*\)/.exec(text);
    if (router || /unplugin-vue-router|vue-router\/vite/.test(text)) {
      // A `getRouteName` option names routes its own way: none is guessed then.
      const options = router?.[1] ?? "";
      folders.push({ folder: /routesFolder\s*:\s*['"`]([^'"`]+)['"`]/.exec(options)?.[1] ?? "src/pages", named: !/\bgetRouteName\b/.test(options) });
    }
    const pages = /\bPages\s*\(\s*(?:\{([\s\S]*?)\})?\s*\)/.exec(text);
    if (pages || /vite-plugin-pages/.test(text)) {
      const body = pages?.[1] ?? "";
      const option = /(?:dirs|pagesDir)\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/.exec(body)?.[1] ?? "";
      const dirs = [...option.matchAll(/['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!).filter((d) => !d.includes("*"));
      folders.push(...(dirs.length > 0 ? dirs : ["src/pages"]).map((folder) => ({ folder, named: false })));
    }
    const seen = new Set<string>();
    return folders.filter((f) => !seen.has(f.folder) && !!seen.add(f.folder));
  }
  return [];
}

/**
 * Map a page file path (relative to the routes folder) to its route path using
 * the unplugin-vue-router / vite-plugin-pages convention. Returns null if the
 * file is not a routable page.
 */
export function fileToRoutePath(relative: string): string | null {
  const noExt = relative.replace(PAGE_FILE_RE, "");
  const out: string[] = [];
  for (const seg of noExt.split("/")) {
    if (seg === "index" || seg === "") continue; // index → the parent's path
    out.push(convertSegment(seg));
  }
  const path = `/${out.join("/")}`;
  return path === "/" ? "/" : path.replace(/\/+$/, "") || "/";
}

/**
 * The name unplugin-vue-router gives a page by default: each segment of its
 * file path adds `/` and the segment as written, an `index` file nothing after
 * the slash — `index/clubs/index.vue` → `//clubs/`, `clubs/[id].vue` → `/clubs/[id]`.
 */
export function fileToRouteName(relative: string): string {
  return relative
    .replace(PAGE_FILE_RE, "")
    .split("/")
    .map((seg) => "/" + (seg === "index" ? "" : seg))
    .join("");
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
