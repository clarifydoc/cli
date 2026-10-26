import type { FileAnalysis } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { ANGULAR_LOAD_CHILDREN_FACT, joinChild } from "./vue-router.js";

/**
 * Angular lazy route modules, served under the record that loads them:
 *
 *   app.routes.ts      { path: 'admin', loadChildren: () => import('./admin/admin.routes') }
 *   admin.routes.ts    { path: 'users/:login/view', loadComponent: … }       → admin/users/:login/view
 *
 * A module's own records are relative to the record whose `loadChildren`
 * imports it; a module loaded by a module is composed after its loader, so
 * the chain reads outermost first. A module two records load takes the first.
 * A loader row whose module serves its own path (`path: ''`) yields to it.
 * A module that only lists imported records composes the files they come from.
 */
export const angularRouterResolver: RouteResolver = {
  id: "angular-load-children",
  languages: ["typescript", "javascript"],
  priority: 49,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const loads: Array<{ a: FileAnalysis; line: number; target: FileAnalysis }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== ANGULAR_LOAD_CHILDREN_FACT) continue;
        const file = ctx.resolveModule(a.filePath, f.data as string);
        const target = file && file !== a.filePath ? ctx.fileOf(file) : undefined;
        if (target) loads.push({ a, line: f.line, target });
      }
    }
    if (loads.length === 0) return;
    // A module whose records are imported route objects (`const accountRoutes: Routes = [registerRoute,
    // settingsRoute]` with each record in a file of its own): those files are loaded with it.
    for (const load of [...loads]) {
      if (load.target.routes.some((r) => r.kind === "frontend")) continue;
      for (const imp of load.target.imports) {
        const file = ctx.resolveModule(load.target.filePath, imp.source);
        const records = file && file !== load.target.filePath ? ctx.fileOf(file) : undefined;
        if (records?.routes.some((r) => r.kind === "frontend") && !loads.some((l) => l.target === records)) {
          loads.push({ a: load.a, line: load.line, target: records });
        }
      }
    }
    const loaded = new Set(loads.map((l) => l.target));
    const composed = new Set<FileAnalysis>();
    for (let round = 0; round < 6; round++) {
      let changed = false;
      for (const { a, line, target } of loads) {
        // Wait for the loader's own path to be composed; never compose a module twice.
        if (composed.has(target) || (loaded.has(a) && !composed.has(a))) continue;
        const parent = a.routes.find((r) => r.kind === "frontend" && r.line === line);
        if (!parent) continue;
        target.routes = target.routes.map((r) => (r.kind === "frontend" ? { ...r, path: joinChild(parent.path, r.path) } : r));
        // The module's own '' record is the page at the loader's path; the loader row only wires it.
        if (target.routes.some((r) => r.kind === "frontend" && r.path === parent.path)) a.routes = a.routes.filter((r) => r !== parent);
        composed.add(target);
        changed = true;
      }
      if (!changed) break;
    }
  },
};
