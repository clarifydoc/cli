import type { Node } from "web-tree-sitter";
import type { FileAnalysis, Language, RouteFact, RouteInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import { guardMiddlewareCalls, withInheritedGuards, type GuardAttr } from "../../shared/route-metadata.js";
import { joinRootedPath } from "../../shared/route-paths.js";
import { extendsChain, innermostClassAt } from "./class-guards.js";

/**
 * Handlers a controller inherits from a base class — NestJS (`@Get` on a
 * `BaseClubController`, `@Controller("clubs")` on the subclass) and Spring
 * (`@GetMapping` on an abstract base, `@RequestMapping("/clubs")` on the
 * subclass). Read per file, the base's handlers are prefix-less rows (`/list`)
 * no call can match, and the subclass serves them at its own prefix
 * (`/clubs/list`). Per file a plugin records each class that holds routes or is
 * a controller deriving from something (`inherited-routes`): whether it is a
 * controller, its prefix, and each route's tail under that prefix. This pass
 * follows the `extends` chain through the class index and copies each base row
 * under every controller subclass, in the base's file (that is where the
 * handler code is); a base that is no controller itself keeps no row of its
 * own. A base the index cannot resolve adds nothing.
 */
const INHERITED_ROUTES = "inherited-routes";

/** One route of a class: the part of its path after the class prefix, null when the tail is no literal. */
interface InheritedRouteTail {
  line: number;
  httpMethod: string | null;
  handler: string | null;
  tail: string | null;
}

interface InheritedRoutesFact {
  /** The class mounts its routes itself (`@Controller`, `@RestController`, a class-level `@RequestMapping`). */
  controller: boolean;
  abstract: boolean;
  /** The class carries any annotation: a custom composite one may be a controller this reader cannot name. */
  decorated: boolean;
  /** The class's own path prefix as written (`clubs`, `/clubs`); empty when none. */
  prefix: string;
  /** The prefix is a constant another module states: its value is read back from the class's own rows. */
  prefixIsRef?: boolean;
  guards: GuardAttr[];
  versions: string[];
  routes: InheritedRouteTail[];
}

/** One class declaration of a file, as a plugin reads it. */
export interface InheritedRouteClass {
  node: Node;
  name: string;
  controller: boolean;
  abstract: boolean;
  decorated: boolean;
  prefix: string;
  prefixIsRef?: boolean;
  guards: GuardAttr[];
  versions: string[];
  /** It names a superclass. */
  derived: boolean;
}

/** The literal tail of a route whose class prefix is a constant: its template is `${Key}` + exactly its path. */
function tailAfterConstant(r: RouteInfo): string | null {
  const m = /^\/?\$\{[^}]*\}([^$]*)$/.exec(r.pathTemplate ?? "");
  if (!m) return null;
  const norm = (p: string) => joinRootedPath([p], { collapse: false });
  return norm(m[1]!) === norm(r.path) ? r.path : null;
}

/** What `path` adds to `prefix`, or null when `path` does not start with it. */
function tailUnder(prefix: string, path: string): string | null {
  const root = joinRootedPath([prefix], { collapse: false });
  if (root === "/") return path;
  if (path === root) return "";
  return path.startsWith(root + "/") ? path.slice(root.length) : null;
}

/**
 * The facts for one file. A route belongs to the innermost class whose lines hold it. A class gets a fact when
 * it holds routes, or is a derived controller (it may serve a base's routes without having any of its own).
 */
export function collectInheritedRouteFacts(classes: readonly InheritedRouteClass[], routes: readonly RouteInfo[], facts: RouteFact[]): void {
  const ownerAt = innermostClassAt(classes);
  const own = new Map<InheritedRouteClass, InheritedRouteTail[]>();
  for (const r of routes) {
    if (r.kind !== "api" || r.mount) continue;
    const owner = ownerAt(r.line);
    if (!owner) continue;
    const list = own.get(owner) ?? [];
    list.push({
      line: r.line,
      httpMethod: r.httpMethod ?? null,
      handler: r.handler ?? null,
      // A row whose path names a constant (beyond the class's own prefix constant) carries no tail a copy could rebuild.
      tail: owner.prefixIsRef ? tailAfterConstant(r) : r.pathTemplate ? null : tailUnder(owner.prefix, r.path),
    });
    own.set(owner, list);
  }
  for (const c of classes) {
    const rows = own.get(c) ?? [];
    if (rows.length === 0 && !(c.controller && c.derived)) continue;
    const data: InheritedRoutesFact = {
      controller: c.controller,
      abstract: c.abstract,
      decorated: c.decorated,
      prefix: c.prefix,
      ...(c.prefixIsRef ? { prefixIsRef: true } : {}),
      guards: c.guards,
      versions: c.versions,
      routes: rows,
    };
    facts.push({ kind: INHERITED_ROUTES, line: c.node.startPosition.row + 1, owner: c.name, data });
  }
}

interface Entry {
  analysis: FileAnalysis;
  ref: ClassRef;
  fact: InheritedRoutesFact;
}

/**
 * `overrideKeepsRoute`: a redeclared handler with no route annotation of its own still serves the inherited
 * route (Spring reads the mapping off the overridden method); without it (NestJS reads decorator metadata off
 * the first method on the prototype chain) a redeclaring subclass mounts nothing for that handler.
 */
export function inheritedControllerRoutes(id: string, languages: readonly Language[], opts: { overrideKeepsRoute: boolean }): RouteResolver {
  return {
    id,
    languages,
    priority: 24,
    resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
      const entries = new Map<ClassRef, Entry>();
      for (const analysis of analyses) {
        for (const f of analysis.routeFacts ?? []) {
          if (f.kind !== INHERITED_ROUTES || !f.owner) continue;
          const ref = ctx.classes.classesIn(analysis.filePath).find((c) => c.cls.name === f.owner);
          if (ref) entries.set(ref, { analysis, ref, fact: f.data as InheritedRoutesFact });
        }
      }
      if (entries.size === 0) return;

      /** The `extends` chain from `sub` up to `base` (sub first, base excluded), or null when it does not reach it. */
      const chainTo = (sub: ClassRef, base: ClassRef): ClassRef[] | null => {
        const up = extendsChain(ctx, sub);
        const at = up.indexOf(base);
        return at < 0 ? null : [sub, ...up.slice(0, at)];
      };
      /** The rows of `analysis` a tail was read from. */
      const rowsOf = (analysis: FileAnalysis, t: InheritedRouteTail): RouteInfo[] =>
        analysis.routes.filter((r) => r.kind === "api" && !r.mount && r.line === t.line && (r.httpMethod ?? null) === t.httpMethod && (r.handler ?? null) === t.handler);
      /** The handlers a link of the chain declares again (Spring: only those with a mapping of their own; NestJS: any method). */
      const declared = (link: ClassRef): Array<string | null> =>
        opts.overrideKeepsRoute ? (entries.get(link)?.fact.routes.map((t) => t.handler) ?? []) : link.cls.methods.map((m) => m.name);

      /** The prefix a controller mounts at: as written, or read back from its own resolved rows when it names a constant. */
      const prefixOf = (e: Entry): string | null => {
        if (!e.fact.prefixIsRef) return e.fact.prefix;
        for (const t of e.fact.routes) {
          if (t.tail === null) continue;
          const row = rowsOf(e.analysis, t)[0];
          if (!row || row.pathUnresolved || row.prefixUnresolved) continue;
          const tail = joinRootedPath([t.tail], { collapse: false });
          if (tail === "/") return row.path;
          if (row.path.endsWith(tail)) return row.path.slice(0, row.path.length - tail.length) || "/";
        }
        return null;
      };

      const added: Array<[FileAnalysis, RouteInfo]> = [];
      const dropped = new Set<RouteInfo>();
      for (const base of entries.values()) {
        if (base.fact.routes.length === 0) continue;
        const subs = ctx.classes.descendants(base.ref).map((r) => entries.get(r)).filter((e): e is Entry => !!e && e.fact.controller && !e.fact.abstract);
        let copied = false;
        for (const sub of subs) {
          const chain = chainTo(sub.ref, base.ref);
          if (!chain) continue;
          const prefix = prefixOf(sub);
          if (prefix === null) continue;
          const redeclared = new Set<string>();
          for (const link of chain) for (const h of declared(link)) if (h) redeclared.add(h);
          const seen = new Map<string, number>();
          for (const t of base.fact.routes) {
            if (t.tail === null || (t.handler && redeclared.has(t.handler))) continue;
            const key = `${t.line}\0${t.httpMethod}\0${t.handler}`;
            const nth = seen.get(key) ?? 0;
            seen.set(key, nth + 1);
            const source = rowsOf(base.analysis, t)[nth];
            if (!source) continue;
            let row: RouteInfo = { ...source, path: joinRootedPath([prefix, t.tail], { collapse: false }) };
            delete row.pathTemplate;
            delete row.prefixUnresolved;
            if (sub.fact.versions.length > 0) row.versions = [...sub.fact.versions];
            if (sub.fact.guards.length > 0) {
              row = withInheritedGuards(row, sub.fact.guards);
              const calls = guardMiddlewareCalls(sub.fact.guards);
              if (calls.length > 0) {
                const entry = { file: sub.analysis.filePath, calls };
                row = { ...row, inheritedMiddleware: [...(row.inheritedMiddleware ?? []), entry] };
              }
            }
            added.push([base.analysis, row]);
            copied = true;
          }
        }
        // A base that is no controller mounts nothing of its own: its rows were the prefix-less reading.
        if (!base.fact.controller && (copied || base.fact.abstract || !base.fact.decorated)) {
          for (const t of base.fact.routes) for (const r of rowsOf(base.analysis, t)) dropped.add(r);
        }
      }
      const touched = new Set<FileAnalysis>(added.map(([a]) => a));
      for (const e of entries.values()) if (e.analysis.routes.some((r) => dropped.has(r))) touched.add(e.analysis);
      for (const a of touched) a.routes = [...a.routes.filter((r) => !dropped.has(r)), ...added.filter(([b]) => b === a).map(([, r]) => r)];
    },
  };
}
