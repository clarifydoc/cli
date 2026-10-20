import type { FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { ANDROID_NAV_GRAPH, NAV_BY_ACTION, NAV_BY_ID, type NavGraphFact } from "../../shared/android-nav-graph.js";

/**
 * Android navigation graphs joined to the code. A graph (read from
 * `res/navigation/*.xml`, a `routeFact`) names each destination's class and
 * the actions between them:
 *
 *   - an action on a destination is an edge from its class to the class the
 *     action reaches — a navigation row in the file declaring the class, at
 *     the class, so the screen builder credits that screen;
 *   - a row by id (`navigate(R.id.action_home_to_detail)`, `@id/…`; Safe Args
 *     `HomeFragmentDirections.actionHomeToDetail()`, `@action/…`) names the
 *     class its action or destination reaches. An id two graphs give two
 *     classes, or one no graph has, names nothing and the row goes.
 */

type Holder = { analysis: FileAnalysis; line: number };

export const androidNavGraphResolver: RouteResolver = {
  id: "android-nav-graph",
  languages: ["java", "kotlin", "springxml"],
  priority: 42,
  resolve(analyses: FileAnalysis[]): void {
    const graphs = analyses.flatMap((a) => (a.routeFacts ?? []).filter((f) => f.kind === ANDROID_NAV_GRAPH).map((f) => f.data as NavGraphFact));
    const code = analyses.filter((a) => a.language === "java" || a.language === "kotlin");

    // One value per key; a key given two is null — it names nothing.
    const single = <V>(map: Map<string, V | null>, key: string, value: V | null | undefined) => {
      if (value == null) return;
      map.set(key, map.has(key) && map.get(key) !== value ? null : value);
    };
    const classOf = new Map<string, string | null>();
    for (const g of graphs) for (const d of g.destinations) single(classOf, d.id, d.cls);
    // Navigating to a nested graph opens its start destination.
    for (const g of graphs) for (const sub of g.graphs) if (sub.start) single(classOf, sub.id, classOf.get(sub.start));
    const actionTo = new Map<string, string | null>();
    const byName = new Map<string, string | null>();
    const camel = (id: string) => id.replace(/_+([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
    for (const g of graphs) {
      for (const a of [...g.destinations.flatMap((d) => d.actions), ...g.actions]) {
        const to = classOf.get(a.to);
        single(actionTo, a.id, to);
        single(byName, camel(a.id), to);
      }
    }

    const holders = new Map<string, Holder | null>();
    for (const a of code) for (const c of a.classes) single(holders, c.name, { analysis: a, line: c.line });
    const row = (target: string, line: number): RouteInfo => ({ path: target, httpMethod: null, kind: "frontend", handler: target, componentPath: target, calls: [], middleware: [], line, navigation: true });
    const has = (a: FileAnalysis, target: string, line: number) => a.routes.some((r) => r.navigation && r.path === target && r.line === line);

    for (const g of graphs) {
      for (const d of g.destinations) {
        const holder = d.cls ? holders.get(d.cls) : undefined;
        if (!holder) continue;
        for (const action of d.actions) {
          const target = classOf.get(action.to);
          if (target && !has(holder.analysis, target, holder.line)) holder.analysis.routes.push(row(target, holder.line));
        }
      }
    }

    for (const a of code) {
      if (!a.routes.some((r) => r.navigation && (r.path.startsWith(NAV_BY_ID) || r.path.startsWith(NAV_BY_ACTION)))) continue;
      const kept: RouteInfo[] = [];
      for (const r of a.routes) {
        const byId = r.navigation && r.path.startsWith(NAV_BY_ID) ? r.path.slice(NAV_BY_ID.length) : null;
        const byAction = r.navigation && r.path.startsWith(NAV_BY_ACTION) ? r.path.slice(NAV_BY_ACTION.length) : null;
        if (byId === null && byAction === null) {
          kept.push(r);
          continue;
        }
        const target = byId !== null ? (actionTo.get(byId) ?? classOf.get(byId)) : byName.get(byAction!);
        if (target && !kept.some((k) => k.navigation && k.path === target && k.line === r.line)) kept.push({ ...r, path: target, handler: target, componentPath: target });
      }
      a.routes = kept;
    }
  },
};
