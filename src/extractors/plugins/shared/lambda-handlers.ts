import type { FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";

/**
 * The function an AWS Lambda handler spec names — shared by the serverless
 * descriptors (serverless.yml, SAM) and CDK stacks.
 *
 * `src/handlers/users.list` is the export `list` of `src/handlers/users.{ts,js,py,…}`
 * under `dir` (a bundler's `dist/` read as `src/` when only that exists; a
 * Python dotted module as its path); `helloworld.App::handleRequest` is the
 * method of the one class `App` that declares it, nearest `dir` first.
 */

/** The extensions a Lambda runtime loads a handler module from, in the order tried. */
const MODULE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", ".tsx", ".jsx", ".py", ".rb", ".csx"];
/** A bundler's output directory names the compiled copy of `src/`. */
const BUILD_DIR_RE = /^(?:dist|build|\.build|lib|out)\//;

/** The function a handler names, its file, and the handler as the row now spells it. */
export interface Hit {
  file: FileAnalysis;
  fn: FunctionInfo;
  handler: string;
}

export const joinRelPath = (dir: string, rel: string): string => {
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
export function lambdaModuleHandler(handler: string, dir: string, ctx: ProjectContext): Hit | null {
  const dot = handler.lastIndexOf(".");
  if (dot <= 0) return null;
  const module = handler.slice(0, dot);
  const name = handler.slice(dot + 1);
  const modules = [module];
  if (BUILD_DIR_RE.test(module)) modules.push(module.replace(BUILD_DIR_RE, "src/"));
  // Python names a package module with dots (`src.api.app`).
  if (!module.includes("/") && module.includes(".")) modules.push(module.replace(/\./g, "/"));
  const bases = modules.map((m) => joinRelPath(dir, m));
  // A build output reached through `..` (`../dist/clubs/index` from a function's folder): its source.
  for (const b of [...bases]) {
    const src = b.replace(/(^|\/)(?:dist|build|\.build|out)\//, "$1src/");
    if (src !== b) bases.push(src);
  }
  for (const base of bases) {
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
export function lambdaClassHandler(handler: string, dir: string, code: readonly FileAnalysis[]): Hit | null {
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
