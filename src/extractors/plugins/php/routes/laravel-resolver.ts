import type { ClassInfo, FileAnalysis } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";

/**
 * `Route::apiResource('albums', AlbumController::class)` registers every CRUD
 * action, but only those the controller declares answer: a row for an action
 * the controller (with its in-project bases and traits) does not define is
 * dropped. A supertype outside the analysis is taken to add none, unless its
 * name says it is a CRUD base (`CrudController`, `ResourceController`); a
 * controller not found once in its sub-project keeps every row.
 */

const RESOURCE_ACTIONS = new Set(["index", "create", "store", "show", "edit", "update", "destroy"]);
const CRUD_BASE = /crud|resource|rest/i;
const MAX_BASES = 5;

export const laravelResourceResolver: RouteResolver = {
  id: "laravel-resources",
  languages: ["php"],
  priority: 41,
  resolve(analyses: FileAnalysis[]): void {
    const classes = new Map<string, Array<{ a: FileAnalysis; cls: ClassInfo }>>();
    for (const a of analyses) {
      if (a.language !== "php") continue;
      for (const cls of a.classes) (classes.get(cls.name) ?? classes.set(cls.name, []).get(cls.name)!).push({ a, cls });
    }
    const find = (name: string, projectId: string | undefined): ClassInfo | null => {
      const own = (classes.get(name) ?? []).filter((c) => c.a.projectId === projectId);
      return own.length === 1 ? own[0]!.cls : null;
    };
    /** The actions a controller answers, or null when a supertype may add some we cannot see. */
    const actionsOf = (name: string, projectId: string | undefined): Set<string> | null => {
      const start = find(name, projectId);
      if (!start) return null;
      const out = new Set<string>();
      const queue = [start];
      const seen = new Set([start.name]);
      for (let i = 0; i < queue.length && i <= MAX_BASES; i++) {
        const cls = queue[i]!;
        for (const m of cls.methods) if (RESOURCE_ACTIONS.has(m.name) || m.name === "__call") out.add(m.name);
        for (const sup of [cls.extends, ...cls.implements]) {
          if (!sup || seen.has(sup)) continue;
          seen.add(sup);
          const found = find(sup, projectId);
          if (found) queue.push(found);
          else if (CRUD_BASE.test(sup)) return null;
        }
      }
      return out.has("__call") ? null : out;
    };

    for (const a of analyses) {
      if (a.language !== "php" || a.routes.length === 0) continue;
      // A resource expansion: two or more action rows of one controller on one line.
      const perLine = new Map<string, number>();
      for (const r of a.routes) {
        const [ctl, action] = (r.handler ?? "").split("#");
        if (ctl && action && RESOURCE_ACTIONS.has(action)) perLine.set(`${r.line}:${ctl}`, (perLine.get(`${r.line}:${ctl}`) ?? 0) + 1);
      }
      const cache = new Map<string, Set<string> | null>();
      const kept = a.routes.filter((r) => {
        const [ctl, action] = (r.handler ?? "").split("#");
        if (!ctl || !action || !RESOURCE_ACTIONS.has(action) || (perLine.get(`${r.line}:${ctl}`) ?? 0) < 2) return true;
        if (!cache.has(ctl)) cache.set(ctl, actionsOf(ctl, a.projectId));
        const actions = cache.get(ctl);
        return !actions || actions.has(action);
      });
      if (kept.length !== a.routes.length) a.routes = kept;
    }
  },
};
