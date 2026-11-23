import type { FileAnalysis, InteractiveElementInfo, Language, SymbolLink } from "../../../types/analysis.js";
import type { DispatchResolver } from "../../dispatch/base.js";
import { importResolver } from "./dom-binding-resolver.js";

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

const cache = new WeakMap<FileAnalysis[], Resolved>();

const normalizeTemplate = (path: string): string => path.replace(/[?#].*$/, "").replace(/^(?:\.{0,2}\/|~\/)+/, "");

/** The last name of a handler as written: `vm.save` runs `save`. */
const memberOf = (handler: string): string => handler.slice(handler.lastIndexOf(".") + 1);

function resolveScoped(analyses: FileAnalysis[]): Resolved {
  const cached = cache.get(analyses);
  if (cached) return cached;
  const out: Resolved = { links: [], handled: new Set() };
  cache.set(analyses, out);
  const pages = analyses.filter((a) => !SCRIPT_LANGUAGES.has(a.language) && a.interactiveElements.some((e) => e.handler && e.event.startsWith("on")));
  if (pages.length === 0) return out;
  const scripts = analyses.filter((a) => SCRIPT_LANGUAGES.has(a.language));
  const registrations = scripts.flatMap((s) => (s.scopeRegistrations ?? []).map((r) => ({ file: s, ...r })));
  const hasScopes = pages.some((p) => p.interactiveElements.some((e) => e.componentScope)) || registrations.some((r) => r.kind === "template");
  if (!hasScopes) return out;
  const resolveImport = importResolver(analyses);
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

  /** The methods named `member` of the component registered as `scope`: [file, symbol, line]. */
  const targetsOf = (scope: string, member: string): Array<{ file: string; symbol: string; line: number }> => {
    const owners = new Map<string, FileAnalysis | null>([[scope, null]]);
    for (const r of components) {
      if (r.name !== scope || !r.value) continue;
      // The module the factory comes from: an import of the registering file, else wherever it is declared.
      const imp = r.file.imports.find((i) => i.specifiers.includes(r.value!) || i.aliases?.[r.value!] !== undefined);
      owners.set(r.value, imp ? resolveImport(imp.source, r.file) : null);
    }
    const found = new Map<string, { file: string; symbol: string; line: number }>();
    for (const [owner, from] of owners) {
      for (const s of scripts) {
        if (from && s !== from) continue;
        for (const c of s.classes) {
          if (c.name !== owner) continue;
          for (const m of c.methods) if (m.name === member) found.set(`${s.filePath}::${owner}.${member}`, { file: s.filePath, symbol: `${owner}.${member}`, line: m.line });
        }
        for (const f of s.functions) if (f.name === `${owner}.${member}`) found.set(`${s.filePath}::${f.name}`, { file: s.filePath, symbol: f.name, line: f.line });
      }
    }
    if (found.size === 0) {
      // A registered factory that states no members: the factory holds the calls of all of them.
      for (const [owner, from] of owners) {
        if (owner === scope && !from) continue;
        for (const s of scripts) {
          if (from && s !== from) continue;
          const fn = s.functions.find((f) => f.name === owner);
          if (fn) found.set(`${s.filePath}::${fn.name}`, { file: s.filePath, symbol: fn.name, line: fn.line });
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
export function handledScopedElements(analyses: FileAnalysis[]): ReadonlySet<InteractiveElementInfo> {
  return resolveScoped(analyses).handled;
}

export class ScopedHandlerResolver implements DispatchResolver {
  readonly id = "scoped-handler";
  readonly languages: Language[] = ["javascript", "typescript", "html", "handlebars", "liquid", "velocity", "razor", "ejs", "erb", "jsp", "php", "heex"];
  readonly priority = 42;

  resolve(analyses: FileAnalysis[]): SymbolLink[] {
    return resolveScoped(analyses).links;
  }
}
