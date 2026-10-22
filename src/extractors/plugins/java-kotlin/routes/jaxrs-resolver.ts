import type { ClassInfo, FileAnalysis, RouteInfo } from "../../../../types/analysis.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { JAXRS_UNMOUNTED_FACT } from "./jaxrs.js";
import { mergePrefix } from "./spring.js";

/**
 * JAX-RS sub-resources, served where a resource mounts them:
 *
 *   @Path("/v1/clubs") interface ClubResource extends SquadResource { … }
 *   interface SquadResource {
 *     @Path("/{clubId}/players") PlayerResource players(@PathParam("clubId") String id);   // locator
 *     @POST @Path("/move/{id}") void move(…);                                             // inherited
 *   }
 *   interface PlayerResource { @GET List<Player> list(); @PUT @Path("/{playerId}") … }
 *
 * gives `POST /v1/clubs/move/{id}`, `GET /v1/clubs/{clubId}/players` and
 * `PUT /v1/clubs/{clubId}/players/{playerId}`. A rooted type (class `@Path`)
 * serves the routes of the `@Path`-less types it extends, and every type a
 * locator — a `@Path` method with no verb — returns is served under the
 * locator's path, recursively. A sub-resource something mounts loses its bare
 * rows; one nothing in the analysis mounts (a framework mounts it) keeps them.
 * Types are looked up by simple name in the sub-project first, else the one
 * definition analysed.
 */

const VERB_MARKER = /^(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/;
const PATH_ANNOTATION = /^Path\s*\(\s*(?:value\s*=\s*)?"([^"]*)"/;
const MAX_DEPTH = 4;

interface ResourceType {
  a: FileAnalysis;
  cls: ClassInfo;
  /** The class `@Path`, null for a sub-resource. */
  prefix: string | null;
  supers: string[];
  locators: Array<{ path: string; returns: string }>;
}

const simpleName = (type: string): string => type.replace(/<.*$/s, "").replace(/\[\]$/, "").split(".").pop()!.trim();

function resourceType(a: FileAnalysis, cls: ClassInfo, serves: boolean): ResourceType | null {
  const prefix = cls.decorators.map((d) => PATH_ANNOTATION.exec(d)?.[1]).find((p) => p !== undefined) ?? null;
  const locators: ResourceType["locators"] = [];
  for (const m of cls.methods) {
    const path = m.decorators.map((d) => PATH_ANNOTATION.exec(d)?.[1]).find((p) => p !== undefined);
    if (path === undefined || m.decorators.some((d) => VERB_MARKER.test(d)) || !m.returnType || m.returnType === "void") continue;
    locators.push({ path, returns: simpleName(m.returnType) });
  }
  const supers = [cls.extends, ...cls.implements].filter((t): t is string => !!t).map(simpleName);
  if (prefix === null && locators.length === 0 && supers.length === 0 && !serves) return null;
  return { a, cls, prefix, supers, locators };
}

export const jaxrsSubResourceResolver: RouteResolver = {
  id: "jaxrs-sub-resources",
  languages: ["java", "kotlin"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    const pending = new Map<FileAnalysis, Map<string, RouteInfo[]>>();
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind !== JAXRS_UNMOUNTED_FACT || !f.owner) continue;
        const byOwner = pending.get(a) ?? pending.set(a, new Map()).get(a)!;
        (byOwner.get(simpleName(f.owner)) ?? byOwner.set(simpleName(f.owner), []).get(simpleName(f.owner))!).push(f.data as RouteInfo);
      }
    }
    const byName = new Map<string, ResourceType[]>();
    let rooted = false;
    for (const a of analyses) {
      if (a.language !== "java" && a.language !== "kotlin") continue;
      const serving = new Set([
        ...a.routes.flatMap((r) => (r.contract ? [simpleName(r.contract.type)] : [])),
        ...(pending.get(a)?.keys() ?? []),
      ]);
      for (const cls of a.classes) {
        const t = resourceType(a, cls, serving.has(cls.name));
        if (!t) continue;
        rooted ||= t.prefix !== null && (t.locators.length > 0 || t.supers.length > 0);
        (byName.get(cls.name) ?? byName.set(cls.name, []).get(cls.name)!).push(t);
      }
    }
    if (!rooted) return;
    const lookup = (name: string, from: FileAnalysis): ResourceType | null => {
      const all = byName.get(name) ?? [];
      const local = all.filter((t) => t.a.projectId === from.projectId);
      if (local.length === 1) return local[0]!;
      return local.length === 0 && all.length === 1 ? all[0]! : null;
    };
    // A type's own rows, as extracted: its `@Path` methods' rows and its verb-only facts.
    const ownRows = (t: ResourceType): RouteInfo[] => [
      ...t.a.routes.filter((r) => r.contract && simpleName(r.contract.type) === t.cls.name),
      ...(pending.get(t.a)?.get(t.cls.name) ?? []),
    ];

    const added = new Map<FileAnalysis, RouteInfo[]>();
    const mounted = new Set<ResourceType>();
    const serve = (t: ResourceType, base: string): void => {
      mounted.add(t);
      const list = added.get(t.a) ?? added.set(t.a, []).get(t.a)!;
      for (const r of ownRows(t)) {
        const path = mergePrefix(base, r.path);
        if (!list.some((x) => x.httpMethod === r.httpMethod && x.path === path && x.handler === r.handler)) list.push({ ...r, path });
      }
    };
    // The routes `t` serves under `base`: its own (unless it is the rooted type, whose rows are
    // already there), its `@Path`-less supertypes', and every locator's type under the locator.
    const mount = (t: ResourceType, base: string, own: boolean, depth: number, stack: ResourceType[]): void => {
      if (depth > MAX_DEPTH || stack.includes(t)) return;
      stack.push(t);
      if (own) serve(t, base);
      for (const l of t.locators) {
        const child = lookup(l.returns, t.a);
        if (child) mount(child, mergePrefix(base, l.path), true, depth + 1, stack);
      }
      for (const s of t.supers) {
        const sup = lookup(s, t.a);
        if (sup && sup.prefix === null) mount(sup, base, true, depth + 1, stack);
      }
      stack.pop();
    };
    for (const types of byName.values()) {
      for (const t of types) if (t.prefix !== null) mount(t, t.prefix, false, 0, []);
    }
    if (added.size === 0) return;

    for (const a of analyses) {
      const extra = added.get(a);
      const dropped = [...mounted].filter((t) => t.a === a && t.prefix === null).map((t) => t.cls.name);
      if (!extra && dropped.length === 0) continue;
      // Replaced, never mutated: the runner stamps `resolvedBy` on new row objects.
      const kept = a.routes.filter((r) => !(r.contract && dropped.includes(simpleName(r.contract.type))));
      a.routes = [...kept, ...(extra ?? [])];
    }
  },
};
