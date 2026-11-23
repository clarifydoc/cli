import type { FileAnalysis, InteractiveElementInfo, Language, SymbolLink } from "../../../types/analysis.js";
import { newDispatchRun, type DispatchResolver, type DispatchRun } from "../../dispatch/base.js";
import { sharedImportResolver } from "./dom-binding-resolver.js";

const SCRIPT_LANGUAGES = new Set<Language>(["javascript", "typescript"]);

/**
 * A template's handler, looked up in the component its markup says it sits in — never by name across the page's
 * scripts. `<div x-data="clubForm"><button @click="save()">` runs `save` of the component registered under
 * `clubForm` (`Alpine.data("clubForm", clubForm)`, the factory possibly imported from another module);
 * `<div ng-controller="ClubCtrl">` / a `templateUrl` a route binds to `controller: "ClubCtrl"` runs the member
 * `ClubCtrl` registered. A second component's `save` is no candidate. The component's methods are the class of that name
 * (an AngularJS controller) or the functions `Factory.save` (an object a factory returns); a registered factory that
 * states no members is the handler itself, which holds the calls of everything it returns.
 */

interface Resolved {
  links: SymbolLink[];
  handled: Set<InteractiveElementInfo>;
}

/** This resolver's slot in a dispatch run; both resolvers that read it are given the same language list. */
const RUN_KEY = {};

const normalizeTemplate = (path: string): string => path.replace(/[?#].*$/, "").replace(/^(?:\.{0,2}\/|~\/)+/, "");

/** The last name of a handler as written: `vm.save` runs `save`. */
const memberOf = (handler: string): string => handler.slice(handler.lastIndexOf(".") + 1);

type Target = { file: string; symbol: string; line: number };
type Entry = Target & { script: FileAnalysis; order: number };

function resolveScoped(analyses: FileAnalysis[], run: DispatchRun): Resolved {
  return run.memo(RUN_KEY, () => buildScoped(analyses, run));
}

function buildScoped(analyses: FileAnalysis[], run: DispatchRun): Resolved {
  const out: Resolved = { links: [], handled: new Set() };
  const pages = analyses.filter((a) => !SCRIPT_LANGUAGES.has(a.language) && a.interactiveElements.some((e) => e.handler && e.event.startsWith("on")));
  if (pages.length === 0) return out;
  const scripts = analyses.filter((a) => SCRIPT_LANGUAGES.has(a.language));
  const registrations = scripts.flatMap((s) => (s.scopeRegistrations ?? []).map((r) => ({ file: s, ...r })));
  const hasScopes = pages.some((p) => p.interactiveElements.some((e) => e.componentScope)) || registrations.some((r) => r.kind === "template");
  if (!hasScopes) return out;
  const resolveImport = sharedImportResolver(analyses, run);
  const projectOf = new Map(analyses.map((a) => [a.filePath, a.projectId]));
  const templates = registrations.filter((r) => r.kind === "template");
  const components = registrations.filter((r) => r.kind === "component");

  /** The controller a template file is bound to, when exactly one route or directive binds it. */
  const controllerOf = (page: FileAnalysis): string | null => {
    const hits = new Set(templates.filter((t) => {
      const want = normalizeTemplate(t.name);
      return want && (page.filePath === want || page.filePath.endsWith(`/${want}`));
    }).map((t) => t.value ?? ""));
    return hits.size === 1 ? [...hits][0] || null : null;
  };

  const componentsByName = new Map<string, typeof components>();
  for (const r of components) (componentsByName.get(r.name) ?? componentsByName.set(r.name, []).get(r.name)!).push(r);
  // Members by owner, in script order (class methods, then `Owner.member` functions, per script).
  const methodsOf = new Map<string, Array<Entry>>();
  const functionsNamed = new Map<string, Array<Entry>>();
  const firstFunction = new Map<string, Array<Entry>>();
  const add = (map: Map<string, Array<Entry>>, key: string, entry: Entry): void => {
    (map.get(key) ?? map.set(key, []).get(key)!).push(entry);
  };
  scripts.forEach((s, order) => {
    for (const c of s.classes) for (const m of c.methods) add(methodsOf, `${c.name}\0${m.name}`, { script: s, order, file: s.filePath, symbol: `${c.name}.${m.name}`, line: m.line });
    const firstHere = new Set<string>();
    for (const f of s.functions) {
      add(functionsNamed, f.name, { script: s, order, file: s.filePath, symbol: f.name, line: f.line });
      if (!firstHere.has(f.name)) (firstHere.add(f.name), add(firstFunction, f.name, { script: s, order, file: s.filePath, symbol: f.name, line: f.line }));
    }
  });

  /** The methods named `member` of the component registered as `scope`: [file, symbol, line]. */
  const targetsOf = (scope: string, member: string): Target[] => {
    const owners = new Map<string, FileAnalysis | null>([[scope, null]]);
    for (const r of componentsByName.get(scope) ?? []) {
      if (!r.value) continue;
      // The module the factory comes from: an import of the registering file, else wherever it is declared.
      const imp = r.file.imports.find((i) => i.specifiers.includes(r.value!) || i.aliases?.[r.value!] !== undefined);
      owners.set(r.value, imp ? resolveImport(imp.source, r.file) : null);
    }
    const found = new Map<string, Target>();
    for (const [owner, from] of owners) {
      // Per script: class methods, then functions (the index holds each in that order).
      const entries = [...(methodsOf.get(`${owner}\0${member}`) ?? []), ...(functionsNamed.get(`${owner}.${member}`) ?? [])];
      entries.sort((x, y) => x.order - y.order);
      for (const e of entries) {
        if (from && e.script !== from) continue;
        found.set(`${e.file}::${e.symbol}`, { file: e.file, symbol: e.symbol, line: e.line });
      }
    }
    if (found.size === 0) {
      // A registered factory that states no members: the factory holds the calls of all of them.
      for (const [owner, from] of owners) {
        if (owner === scope && !from) continue;
        for (const e of firstFunction.get(owner) ?? []) {
          if (from && e.script !== from) continue;
          found.set(`${e.file}::${e.symbol}`, { file: e.file, symbol: e.symbol, line: e.line });
        }
      }
    }
    return [...found.values()];
  };

  for (const page of pages) {
    const bound = controllerOf(page);
    const seen = new Set<string>();
    for (const el of page.interactiveElements) {
      if (!el.handler || !el.event.startsWith("on") || el.request) continue;
      const scope = el.componentScope === undefined ? bound : el.componentScope || null;
      if (!scope) continue;
      const member = memberOf(el.handler);
      const targets = targetsOf(scope, member);
      // Two components of one name stay unjoined: which one this page runs is not stated.
      // Several apps declaring one name: the page's own sub-project decides, else nothing does.
      let chosen = targets;
      if (new Set(targets.map((t) => t.file)).size > 1) chosen = targets.filter((t) => projectOf.get(t.file) === page.projectId);
      if (chosen.length === 0 || new Set(chosen.map((t) => t.file)).size > 1) continue;
      out.handled.add(el);
      for (const t of chosen) {
        const key = `${member}@${el.line}::${t.file}::${t.symbol}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.links.push({
          sourceFile: page.filePath,
          sourceSymbol: "<component>",
          sourceLine: el.line,
          callName: member,
          targetFile: t.file,
          targetSymbol: t.symbol,
          targetLine: t.line,
          confidence: "INFERRED",
        });
      }
    }
  }
  return out;
}

/** The elements a component scope claims and joins: the name-based resolver leaves them alone. */
export function handledScopedElements(analyses: FileAnalysis[], run: DispatchRun = newDispatchRun()): ReadonlySet<InteractiveElementInfo> {
  return resolveScoped(analyses, run).handled;
}

export class ScopedHandlerResolver implements DispatchResolver {
  readonly id = "scoped-handler";
  readonly languages: Language[] = ["javascript", "typescript", "html", "handlebars", "liquid", "velocity", "razor", "ejs", "erb", "jsp", "php", "heex"];
  readonly priority = 42;

  resolve(analyses: FileAnalysis[], run: DispatchRun = newDispatchRun()): SymbolLink[] {
    return resolveScoped(analyses, run).links;
  }
}
