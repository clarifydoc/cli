import type { EntryPointInfo, FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import type { LambdaEnv } from "./environment.js";
import { lambdaClassHandler, lambdaModuleHandler, type Hit } from "../shared/lambda-handlers.js";


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
        const hit = r.handler ? anchor(r.handler, dir, code, ctx) : null;
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
    // The functions a schedule or a queue runs: entry points on the code, like the routes.
    const movedEntries = new Map<FileAnalysis, EntryPointInfo[]>();
    for (const a of analyses) {
      if (a.language !== "serverless" || !a.entryPoints?.length) continue;
      const dir = a.filePath.includes("/") ? a.filePath.slice(0, a.filePath.lastIndexOf("/")) : "";
      const kept: EntryPointInfo[] = [];
      for (const e of a.entryPoints) {
        const hit = e.handler ? anchor(e.handler, dir, code, ctx) : null;
        if (!hit) {
          kept.push(e);
          continue;
        }
        const list = movedEntries.get(hit.file) ?? [];
        list.push({ ...e, handler: hit.handler, line: hit.fn.line });
        movedEntries.set(hit.file, list);
      }
      a.entryPoints = kept.length ? kept : undefined;
    }
    for (const [a, rows] of movedEntries) a.entryPoints = [...(a.entryPoints ?? []), ...rows];
    applyEnvironment(analyses, code, ctx);
  },
};

/**
 * A table (or any name) a data source reads from an environment variable (`DataSourceInfo.envRef`) takes the
 * value the descriptor above it sets (`environment.ts`): the descriptor-wide environment for any file below it,
 * a function's own for the module its handler names, which wins. A name only a descriptor of ANOTHER directory
 * sets stays empty, and so does one two descriptors (or two functions of one module) set differently.
 */
function applyEnvironment(analyses: readonly FileAnalysis[], code: readonly FileAnalysis[], ctx: ProjectContext): void {
  const wanted = code.filter((a) => a.dataSources.some((d) => d.envRef && !d.target));
  if (wanted.length === 0) return;
  const seen = new Map<FileAnalysis, Map<string, Set<string>>>();
  const descriptorDirs = analyses
    .filter((d) => d.language === "serverless" && d.routeFacts?.some((f) => f.kind === "lambda-env"))
    .map((d) => (d.filePath.includes("/") ? d.filePath.slice(0, d.filePath.lastIndexOf("/")) : ""));
  for (const d of analyses) {
    const facts = d.language === "serverless" ? (d.routeFacts ?? []).filter((f) => f.kind === "lambda-env") : [];
    if (facts.length === 0) continue;
    const dir = d.filePath.includes("/") ? d.filePath.slice(0, d.filePath.lastIndexOf("/")) : "";
    const wide: Record<string, string> = {};
    const own = new Map<FileAnalysis, Map<string, Set<string>>>();
    for (const f of facts) {
      const data = f.data as LambdaEnv;
      if (data.handler === null) {
        Object.assign(wide, data.env);
        continue;
      }
      const hit = anchor(data.handler, dir, code, ctx);
      if (!hit) continue;
      const names = own.get(hit.file) ?? own.set(hit.file, new Map()).get(hit.file)!;
      for (const [k, v] of Object.entries(data.env)) (names.get(k) ?? names.set(k, new Set()).get(k)!).add(v);
    }
    for (const a of wanted) {
      if (dir && !a.filePath.startsWith(`${dir}/`)) continue;
      // The nearest descriptor speaks for a file: a service nested below this one has its own.
      if (descriptorDirs.some((o) => o.length > dir.length && a.filePath.startsWith(`${o}/`))) continue;
      // A module a function's handler names takes what those functions run with (provider values merged in);
      // any other file below the descriptor, the descriptor-wide environment.
      const mine = own.get(a);
      for (const k of new Set([...Object.keys(wide), ...(mine?.keys() ?? [])])) {
        const values = mine ? mine.get(k) : new Set([wide[k]!]);
        if (!values) continue;
        const all = seen.get(a) ?? seen.set(a, new Map()).get(a)!;
        const into = all.get(k) ?? all.set(k, new Set()).get(k)!;
        for (const v of values) into.add(v);
      }
    }
  }
  for (const a of wanted) {
    const all = seen.get(a);
    for (const ds of a.dataSources) {
      if (!ds.envRef || ds.target) continue;
      const values = all?.get(ds.envRef);
      if (values?.size !== 1) continue;
      const [table] = values;
      ds.target = table!;
      ds.entity = table!;
      delete ds.envRef;
    }
  }
}

/** The function a handler names; `a|b|c` lists the runtime's defaults, the first one present wins. */
function anchor(handler: string, dir: string, code: readonly FileAnalysis[], ctx: ProjectContext): Hit | null {
  for (const h of handler.split("|")) {
    const hit = h.includes("::") ? lambdaClassHandler(h, dir, code) : lambdaModuleHandler(h, dir, ctx);
    if (hit) return hit;
  }
  return null;
}
