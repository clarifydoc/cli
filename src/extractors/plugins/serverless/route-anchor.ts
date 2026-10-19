import type { FileAnalysis, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";

/** The extensions a Lambda runtime loads a handler module from, in the order tried. */
const MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", ".py", ".rb"];
/** A bundler's output directory names the compiled copy of `src/`. */
const BUILD_DIR_RE = /^(?:dist|build|\.build|lib|out)\//;

/**
 * Serverless routes, anchored on the function that serves them.
 *
 * A `serverless.yml` / SAM template declares the route; the handler is the
 * code a request runs, and that is where a caller's link should land (as for
 * Rails' `config/routes.rb`). `src/handlers/users.list` is the export `list`
 * of `src/handlers/users.{ts,js,py,…}` beside the descriptor (a bundler's
 * `dist/` read as `src/` when only that exists; a Python dotted module as its
 * path); `helloworld.App::handleRequest` is the method of the one class `App`
 * that declares it, nearest the descriptor first. A row whose handler names
 * nothing the project defines — a compiled Go binary, a layer's code — stays
 * on the descriptor.
 */
export const serverlessHandlerAnchor: RouteResolver = {
  id: "serverless-handler-anchor",
  languages: ["serverless", "typescript", "javascript", "python", "ruby", "java", "kotlin", "csharp"],
  priority: 50,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const code = analyses.filter((a) => a.language !== "serverless");
    const moved = new Map<FileAnalysis, RouteInfo[]>();
    for (const a of analyses) {
      if (a.language !== "serverless" || a.routes.length === 0) continue;
      const dir = a.filePath.includes("/") ? a.filePath.slice(0, a.filePath.lastIndexOf("/")) : "";
      const kept: RouteInfo[] = [];
      for (const r of a.routes) {
        const hit = r.handler ? (r.handler.includes("::") ? classHandler(r.handler, dir, code) : moduleHandler(r.handler, dir, ctx)) : null;
        if (!hit) {
          kept.push(r);
          continue;
        }
        const list = moved.get(hit.file) ?? [];
        list.push({ ...r, handler: hit.handler, line: hit.fn.line, calls: hit.fn.calls });
        moved.set(hit.file, list);
      }
      if (kept.length !== a.routes.length) a.routes = kept;
    }
    for (const [a, rows] of moved) a.routes = [...a.routes, ...rows];
  },
};

/** The function a handler names, its file, and the handler as the row now spells it. */
interface Hit {
  file: FileAnalysis;
  fn: FunctionInfo;
  handler: string;
}

const joinPath = (dir: string, rel: string): string => {
  const parts = (dir ? `${dir}/${rel}` : rel).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
};

/** `src/handlers/users.list` → the export `list` of the module file. */
function moduleHandler(handler: string, dir: string, ctx: ProjectContext): Hit | null {
  const dot = handler.lastIndexOf(".");
  if (dot <= 0) return null;
  const module = handler.slice(0, dot);
  const name = handler.slice(dot + 1);
  const modules = [module];
  if (BUILD_DIR_RE.test(module)) modules.push(module.replace(BUILD_DIR_RE, "src/"));
  // Python names a package module with dots (`src.api.app`).
  if (!module.includes("/") && module.includes(".")) modules.push(module.replace(/\./g, "/"));
  for (const m of modules) {
    const base = joinPath(dir, m);
    for (const path of [...MODULE_EXTENSIONS.map((e) => base + e), ...MODULE_EXTENSIONS.map((e) => `${base}/index${e}`)]) {
      const file = ctx.fileOf(path);
      if (!file) continue;
      // `export const list = …`, `def list`, and the `exports.list = …` / `module.exports.list = …` spellings.
      // A renamed local export (`export { del as delete }`) stands for its local binding.
      const local = file.exports.find((e) => e.name === name && !e.source && e.sourceName)?.sourceName;
      const fn =
        file.functions.find((f) => f.name === name) ??
        file.functions.find((f) => f.name.endsWith(`exports.${name}`)) ??
        (local ? file.functions.find((f) => f.name === local) : undefined);
      return fn ? { file, fn, handler: fn.name } : null;
    }
  }
  return null;
}

/**
 * `helloworld.App::handleRequest` (Java), `Asm::Ns.Fn::Handler` (.NET): the
 * method of the one class of that name declaring it — the ones under the
 * descriptor's directory first.
 */
function classHandler(handler: string, dir: string, code: readonly FileAnalysis[]): Hit | null {
  const parts = handler.split("::");
  const method = parts.length >= 2 ? parts[parts.length - 1]! : null;
  const written = parts[parts.length - 2]!;
  const simple = written.slice(written.lastIndexOf(".") + 1);
  if (!method || !simple) return null;
  const hits: Hit[] = [];
  for (const a of code) {
    for (const c of a.classes) {
      if (c.name !== simple && c.name !== written && !c.name.endsWith(`.${simple}`)) continue;
      const fn = c.methods.find((m) => m.name === method || m.name === `${c.name}.${method}`);
      if (fn) hits.push({ file: a, fn, handler: `${c.name}.${method}` });
    }
  }
  const near = dir ? hits.filter((h) => h.file.filePath.startsWith(`${dir}/`)) : hits;
  const pool = near.length > 0 ? near : hits;
  return pool.length === 1 ? pool[0]! : null;
}
