import type { EntryPointInfo, FileAnalysis, RouteInfo } from "../../../types/analysis.js";
import type { ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { lambdaClassHandler, lambdaModuleHandler } from "../shared/lambda-handlers.js";


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
        const hit = r.handler ? (r.handler.includes("::") ? lambdaClassHandler(r.handler, dir, code) : lambdaModuleHandler(r.handler, dir, ctx)) : null;
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
        const hit = e.handler ? (e.handler.includes("::") ? lambdaClassHandler(e.handler, dir, code) : lambdaModuleHandler(e.handler, dir, ctx)) : null;
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
  },
};
