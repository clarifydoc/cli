import type { ClassInfo, FileAnalysis, Language, SymbolLink } from "../../../../types/analysis.js";
import type { DispatchResolver } from "../../../dispatch/base.js";

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
 * states one. Only a chain that ends on one of DRF's generic bases is followed,
 * and only through bases named once in the analysis (or in the class's file).
 */

/** The hooks DRF's mixins and `GenericAPIView` call on the instance, by method. */
const LIBRARY_CALLS: Record<string, readonly string[]> = {
  list: ["get_queryset", "filter_queryset", "paginate_queryset", "get_serializer", "get_paginated_response"],
  create: ["get_serializer", "perform_create", "get_success_headers"],
  retrieve: ["get_object", "get_serializer"],
  update: ["get_object", "get_serializer", "perform_update"],
  partial_update: ["update"],
  destroy: ["get_object", "perform_destroy"],
  get_object: ["get_queryset", "filter_queryset", "check_object_permissions"],
  get_serializer: ["get_serializer_class", "get_serializer_context"],
};

/** DRF's generic bases: the ones that supply the actions and hooks above. */
const DRF_GENERIC_BASE = /^(?:ModelViewSet|ReadOnlyModelViewSet|GenericViewSet|GenericAPIView|(?:List|Create|Retrieve|Update|Destroy)ModelMixin)$/;

const SUPER_CALL = /^super\s*\([^)]*\)\s*\.\s*(\w+)$/;

interface ClassAt {
  cls: ClassInfo;
  file: FileAnalysis;
}

/** `rest_framework.viewsets.ModelViewSet[Club]` → `ModelViewSet`. */
const bareName = (written: string): string => written.replace(/\[.*$/s, "").trim().split(".").pop()!;

export class DrfViewSetActionResolver implements DispatchResolver {
  readonly id = "drf-action";
  readonly languages: Language[] = ["python"];
  readonly priority = 61;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    const routed = analyses.filter((a) => a.routes.some((r) => r.owner && r.kind === "api" && r.handler && LIBRARY_CALLS[r.handler.split(".").pop()!]));
    if (routed.length === 0) return [];
    const byName = new Map<string, ClassAt[]>();
    for (const a of analyses) for (const cls of a.classes) (byName.get(cls.name) ?? byName.set(cls.name, []).get(cls.name)!).push({ cls, file: a });
    /** A class by name: the one in `near`'s file, else the only one. */
    const classNamed = (name: string, near: FileAnalysis): ClassAt | null => {
      const all = byName.get(name) ?? [];
      return all.find((c) => c.file === near) ?? (all.length === 1 ? all[0]! : null);
    };

    /** The project classes of the chain in resolution order, and whether it ends on a DRF generic base. */
    const chainMemo = new Map<ClassInfo, { chain: ClassAt[]; drf: boolean }>();
    const chainOf = (start: ClassAt): { chain: ClassAt[]; drf: boolean } => {
      const memo = chainMemo.get(start.cls);
      if (memo) return memo;
      const chain: ClassAt[] = [];
      let drf = false;
      const seen = new Set<ClassInfo>();
      // Depth-first, left to right: Python's order wherever the bases share no ancestor.
      const visit = (c: ClassAt, depth: number) => {
        if (seen.has(c.cls) || depth > 8) return;
        seen.add(c.cls);
        chain.push(c);
        for (const written of [c.cls.extends, ...c.cls.implements]) {
          if (!written) continue;
          const name = bareName(written);
          const base = name === c.cls.name ? null : classNamed(name, c.file);
          if (base) visit(base, depth + 1);
          else if (DRF_GENERIC_BASE.test(name)) drf = true;
        }
      };
      visit(start, 0);
      const out = { chain, drf };
      chainMemo.set(start.cls, out);
      return out;
    };

    const links: SymbolLink[] = [];
    for (const a of routed) {
      for (const r of a.routes) {
        if (!r.owner || r.kind !== "api" || !r.handler) continue;
        const action = r.handler.split(".").pop()!;
        if (!LIBRARY_CALLS[action]) continue;
        const owner = classNamed(r.owner, a);
        if (!owner) continue;
        const { chain, drf } = chainOf(owner);
        if (!drf) continue;
        const sourceSymbol = `route:${r.httpMethod ?? "USE"} ${r.path}`;
        const seen = new Set<string>();
        const link = (target: ClassAt, symbol: string, line: number, callName: string) => {
          const key = `${target.file.filePath}\0${symbol}`;
          if (seen.has(key)) return;
          seen.add(key);
          links.push({ sourceFile: a.filePath, sourceSymbol, sourceLine: r.line, callName, targetFile: target.file.filePath, targetSymbol: symbol, targetLine: line, resolvedBy: "text", confidence: "INFERRED" });
        };
        /** The project method of this name nearest the viewset, at or after `from` in the chain. */
        const declared = (name: string, from: number): { at: number; fn: ClassInfo["methods"][number] } | null => {
          for (let i = from; i < chain.length; i++) {
            const fn = chain[i]!.cls.methods.find((m) => m.name === name);
            if (fn) return { at: i, fn };
          }
          return null;
        };
        const queryset = (): void => {
          // The class whose body states `queryset = …`: a database read outside its methods.
          const stating = chain.find((c) => (c.file.dataSources ?? []).some((d) =>
            d.kind === "database" && d.line > c.cls.line && d.line <= c.cls.endLine && !c.cls.methods.some((m) => d.line >= m.line && d.line <= m.endLine)));
          const target = stating ?? owner;
          link(target, target.cls.name, target.cls.line, owner.cls.name);
        };
        /** What runs for `self.<name>()` from `from` down the chain, the library's own past the project's. */
        const runs = (name: string, from: number, depth: number, linkDeclared: boolean): void => {
          if (depth > 6) return;
          const decl = declared(name, from);
          if (decl) {
            if (linkDeclared) link(chain[decl.at]!, `${chain[decl.at]!.cls.name}.${name}`, decl.fn.line, `self.${name}`);
            // Handed on to the base (a project base's, which the linker links, else DRF's): what that runs.
            if (!decl.fn.calls.some((c) => SUPER_CALL.exec(c.name)?.[1] === name)) return;
            return runs(name, decl.at + 1, depth + 1, false);
          }
          if (name === "get_queryset") return queryset();
          for (const hook of LIBRARY_CALLS[name] ?? []) runs(hook, 0, depth + 1, true);
        };
        // The action itself is the route's handler: only what runs past it is new. (A framework-supplied
        // action's link to the viewset's own body is core's; this one, the same, is deduplicated away.)
        const start = Math.max(0, chain.findIndex((c) => c.cls.name === r.handler!.split(".")[0]));
        runs(action, start, 0, false);
      }
    }
    return links;
  }
}
