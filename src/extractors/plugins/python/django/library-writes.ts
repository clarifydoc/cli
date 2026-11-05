import type { DataSourceInfo, FileAnalysis } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { type ClassAt, declaredAlong, DRF_GENERIC_VIEW, PythonClassIndex } from "./drf.js";
import { serializerSites } from "./serializer-dispatch.js";

/**
 * The tables DRF's own code writes where the project writes no code of its own.
 *
 * `router.register("clubs", ClubViewSet)` over a `ModelViewSet` that overrides nothing serves `POST /clubs/`
 * with the library's `create`, which saves through the view's serializer into the model its `queryset`
 * names: the route writes that table, though no project line says so. The same goes for `update`,
 * `partial_update` and `destroy`, for a generic view's `POST`/`PUT`/`PATCH`/`DELETE`
 * (`CreateAPIView`), and for a project override that hands on with `super().create(…)`.
 *
 * Likewise a `ModelSerializer` whose `create` / `update` the project does not override: `serializer.save()` in
 * a function writes the `Meta.model` table (`serializerSites` says which calls are such saves).
 *
 * Both are stated as `database` rows the route / function owns (`DataSourceInfo.handler` naming the route's
 * anchor, or the call's own line), with `access: "write"`, so the data flows say `db-write`. A `queryset` or
 * `Meta.model` the project does not state, a `get_serializer_class` picking one at run time, or a serializer
 * with an own `create`/`update` (its body's accesses count) adds nothing.
 */

const WRITE_ACTIONS = new Set(["create", "update", "partial_update", "destroy"]);
/** A generic API view's methods that write, by the verb the route carries. */
const WRITE_VERBS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const VERB_ACTION: Record<string, string> = { POST: "create", PUT: "update", PATCH: "partial_update", DELETE: "destroy" };
/** The hook each write action calls to do its work. */
const PERFORM: Record<string, string> = { create: "perform_create", update: "perform_update", destroy: "perform_destroy" };
const MODEL_SERIALIZER = /^(?:ModelSerializer|HyperlinkedModelSerializer)$/;
const SUPER_CALL = /^super\s*\([^)]*\)\s*\.\s*(\w+)$/;

/** Whether the library's code for `name` runs for this class chain: no project method, or one handing on with `super()`. */
function libraryRuns(chain: readonly ClassAt[], name: string): boolean {
  let from = 0;
  for (let depth = 0; depth < 8; depth++) {
    const decl = declaredAlong(chain, name, from);
    if (!decl) return true;
    if (!decl.fn.calls.some((c) => SUPER_CALL.exec(c.name)?.[1] === name)) return false;
    from = decl.at + 1;
  }
  return false;
}

const addRow = (a: FileAnalysis, row: DataSourceInfo): void => {
  if (a.dataSources.some((d) => d.kind === "database" && d.line === row.line && d.name === row.name && d.handler === row.handler && d.entity === row.entity)) return;
  a.dataSources.push(row);
};

export const drfLibraryWrites: RouteResolver = {
  id: "drf-library-writes",
  languages: ["python"],
  priority: 31,
  resolve(analyses: FileAnalysis[], _ctx: ProjectContext): void {
    const candidates = analyses.filter((a) => (a.routeFacts ?? []).length > 0 || a.routes.some((r) => r.owner || r.handler) || a.classes.length > 0);
    if (candidates.length === 0) return;
    const index = new PythonClassIndex(analyses);
    /** The model a view's `queryset` names, else its serializer's `Meta.model`. */
    const modelOf = (chain: readonly ClassAt[]): string | null => {
      for (const c of chain) {
        const row = c.file.dataSources.find((d) => d.kind === "database" && d.entity && d.line > c.cls.line && d.line <= c.cls.endLine
          && !c.cls.methods.some((m) => d.line >= m.line && d.line <= m.endLine) && /(?:^|\.)objects\b/.test(d.name));
        if (row) return row.entity!;
      }
      const serializer = index.viewSerializer(chain);
      return serializer ? index.metaModelOf(index.chainOf(serializer).chain)?.model ?? null : null;
    };

    // ── A route whose write is the library's ──
    for (const a of analyses) {
      for (const r of a.routes) {
        if (r.kind !== "api" || !r.httpMethod || !r.handler) continue;
        const method = r.httpMethod.toUpperCase();
        const dot = r.handler.indexOf(".");
        // A registered viewset's action (`owner` + `Class.action`), or a generic view named by its class.
        const action = dot >= 0 ? r.handler.slice(dot + 1) : VERB_ACTION[method] ?? null;
        const className = r.owner ?? (dot < 0 ? r.handler : null);
        if (!className || !action || !WRITE_ACTIONS.has(action) || (dot < 0 && !WRITE_VERBS.has(method))) continue;
        const cls = index.classNamed(className, a);
        if (!cls) continue;
        const { chain, external } = index.chainOf(cls);
        if (!external.some((b) => DRF_GENERIC_VIEW.test(b))) continue;
        // Every step down to the save is the library's (a project one handing on with `super()` still is).
        const steps = [...(dot < 0 ? [method.toLowerCase()] : []), action, ...(action === "partial_update" ? ["update"] : []), PERFORM[action === "partial_update" ? "update" : action]!];
        if (!steps.every((step) => libraryRuns(chain, step))) continue;
        const model = modelOf(chain);
        if (!model) continue;
        const entity = model.split(".").pop()!;
        addRow(a, {
          kind: "database", name: `${className}: ${action ?? method.toLowerCase()}`, target: entity, entity, access: "write",
          line: r.line, handler: `route:${r.httpMethod} ${r.path}`, calls: [],
        });
      }
    }

    // ── A `serializer.save()` that runs the library's create / update ──
    for (const site of serializerSites(candidates)) {
      if (site.run !== "save:create" && site.run !== "save:update") continue;
      const { chain, external } = index.chainOf(site.serializer);
      if (!external.some((b) => MODEL_SERIALIZER.test(b))) continue;
      const step = site.run === "save:create" ? "create" : "update";
      if (!libraryRuns(chain, "save") || !libraryRuns(chain, step)) continue;
      const model = index.metaModelOf(chain)?.model;
      if (!model) continue;
      const entity = model.split(".").pop()!;
      addRow(site.file, { kind: "database", name: `${site.callName} (${site.serializer.cls.name}.${step})`, target: entity, entity, access: "write", line: site.line, calls: [] });
    }
  },
};
