import type { FileAnalysis, Language, SymbolLink } from "../../../../types/analysis.js";
import type { DispatchResolver } from "../../../dispatch/base.js";
import { DRF_GENERIC_VIEW, follow, type FollowVisitor, PythonClassIndex, serializerRuns, VIEW_CALLS } from "./drf.js";

/**
 * What DRF's own code runs for a router-registered ViewSet's action, and which of
 * it the project overrides.
 *
 * `router.register("clubs", ClubViewSet)` serves `PATCH /clubs/{pk}/` with
 * `partial_update` — the viewset's own method when the project writes one (the
 * route resolver anchors the route there), else the one `UpdateModelMixin`
 * provides. The library's action calls hooks on the instance — `get_object`,
 * `get_queryset`, `perform_update`, … — and those are what a project overrides
 * to do its work. Nothing in the source calls them, so the route reached
 * nothing past a `super().partial_update(…)`.
 *
 * For each route a router registration gives (`RouteInfo.owner`, the
 * registered viewset), this follows the action down the viewset's class
 * chain: a project method that hands on to `super().<action>(…)`, or no project
 * method at all, means the library's action runs; each hook it calls is then
 * the nearest project override along the chain (linked from the route), or the
 * library's own, followed into the hooks IT calls. The library's
 * `get_queryset` reads the class-level `queryset`, so it links the class that
 * states one; `create` and `update` hand the request to the view's
 * `serializer_class`, whose `is_valid()` and `save()` run its project methods
 * (`drf.ts`). Only a chain that ends on one of DRF's generic bases is followed,
 * through bases the class's file declares or imports from the project.
 */

export class DrfViewSetActionResolver implements DispatchResolver {
  readonly id = "drf-action";
  readonly languages: Language[] = ["python"];
  readonly priority = 61;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const routed = analyses.filter((a) => a.routes.some((r) => r.owner && r.kind === "api" && r.handler && VIEW_CALLS[r.handler.split(".").pop()!]));
    if (routed.length === 0) return [];
    const index = new PythonClassIndex(analyses);

    const links: SymbolLink[] = [];
    for (const a of routed) {
      for (const r of a.routes) {
        if (!r.owner || r.kind !== "api" || !r.handler) continue;
        const action = r.handler.split(".").pop()!;
        if (!VIEW_CALLS[action]) continue;
        const owner = index.classNamed(r.owner, a);
        if (!owner) continue;
        const { chain, external } = index.chainOf(owner);
        if (!external.some((b) => DRF_GENERIC_VIEW.test(b))) continue;
        const sourceSymbol = `route:${r.httpMethod ?? "USE"} ${r.path}`;
        const seen = new Set<string>();
        const link = (file: FileAnalysis, symbol: string, line: number, callName: string) => {
          const key = `${file.filePath}\0${symbol}`;
          if (seen.has(key)) return;
          seen.add(key);
          links.push({ sourceFile: a.filePath, sourceSymbol, sourceLine: r.line, callName, targetFile: file.filePath, targetSymbol: symbol, targetLine: line, resolvedBy: "text", confidence: "INFERRED" });
        };
        const serializer = index.viewSerializer(chain);
        const visitor: FollowVisitor = {
          declared: (c, fn) => link(c.file, `${c.cls.name}.${fn.name}`, fn.line, `self.${fn.name}`),
          library(name) {
            if (name === "get_queryset") {
              // The class whose body states `queryset = …`: a database read outside its methods.
              const stating = chain.find((c) => (c.file.dataSources ?? []).some((d) =>
                d.kind === "database" && d.line > c.cls.line && d.line <= c.cls.endLine && !c.cls.methods.some((m) => d.line >= m.line && d.line <= m.endLine)));
              const target = stating ?? owner;
              link(target.file, target.cls.name, target.cls.line, owner.cls.name);
              return true;
            }
            if (!name.startsWith("serializer.")) return false;
            const call = name.slice("serializer.".length) as "is_valid" | "save:create" | "save:update";
            if (serializer) serializerRuns(index, serializer, call, (file, symbol, line) => link(file, symbol, line, `serializer.${call.split(":")[0]}`));
            return true;
          },
        };
        // The action itself is the route's handler: only what runs past it is new. (A framework-supplied
        // action's link to the viewset's own body is core's; this one, the same, is deduplicated away.)
        const start = Math.max(0, chain.findIndex((c) => c.cls.name === r.handler!.split(".")[0]));
        follow(chain, action, VIEW_CALLS, visitor, start, false);
      }
    }
    return links;
  }
}
