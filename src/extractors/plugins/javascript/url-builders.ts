/**
 * Project-level resolution of URL-builder helper calls in frontend api-call URLs.
 *
 * Real Vue/React data layers funnel every request through a project-defined
 * helper that assembles the base + version + path:
 *
 *   // utils/uriUtils.ts
 *   export function requestUri(endpoint, version = 'v2') {
 *     return import.meta.env.VITE_API + '/api/' + version + '/institution/' + id + '/' + endpoint;
 *   }
 *   // some.service.ts
 *   axios.get(requestUri('teamtalk', 'v4'))   // → /api/v4/institution/{}/teamtalk
 *
 * The per-file extractor captures the helper's parameterized template
 * (`FunctionInfo.urlTemplate`) and the call site's api-call target verbatim
 * (`requestUri('teamtalk', 'v4')`, or `` `${requestUri(...)}/${id}` ``). This
 * pass builds a project-wide helper index and substitutes each call site's
 * literal arguments into the matching template, so the api-call carries a
 * concrete app-relative URL that {@link linkApiCallsToRoutes} can join to the
 * backend route. The helper definition and its call sites are almost always in
 * different files, so this must run after per-file analysis (it mirrors
 * `resolveRouterMounts` / `detectFileBasedRoutes`).
 *
 * Operates on the aggregated api-call list in memory; per-file JSON is untouched.
 */

import type { DataSourceInfo, FileAnalysis, FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import type { ClassRef, ProjectContext } from "../../../types/project.js";
// The quote/bracket-aware splitter and unquoter are shared with the symbolic
// value resolver (one copy instead of the three that used to exist).
import { splitTopLevel, unquote } from "../../shared/value-resolver.js";

interface UrlBuilder {
  /** Every distinct template the helper may return, primary first. */
  templates: string[];
  params: ParamInfo[];
}

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * Resolve one call argument to a path fragment. A bare string/template literal
 * yields its content; a concatenation (`'trainings/' + x.externalId`) keeps
 * its literal segments and reduces each runtime part to a `{}` wildcard so the
 * path still matches a parameterized route. A single non-literal (a bare
 * variable holding the whole value) returns null so a parameter default can fill
 * in instead (e.g. a version arg).
 */
function argLiteral(raw: string): string | null {
  const parts = splitTopLevel(raw, "+");
  if (parts.length === 1) {
    const t = parts[0]!.trim();
    if (t.startsWith("'") || t.startsWith('"') || t.startsWith("`")) return unquote(t);
    return null; // single identifier/expression — unresolvable; use default
  }
  return parts
    .map((p) => {
      const t = p.trim();
      const isLit = t.startsWith("'") || t.startsWith('"') || t.startsWith("`");
      return isLit ? unquote(t) : "{}"; // runtime part → wildcard
    })
    .join("");
}

/**
 * Substitute a call's literal args into one template's `{param}` tokens.
 * Null when a parameter the template uses is passed as a bare variable with
 * no default (`APIUrl(url)`): the resulting URL would be all wildcard, and a
 * `/api/{}` says nothing about which route the call reaches — better to leave
 * the call unresolved than to let it join whatever `/api/:id` exists.
 */
function substitute(template: string, params: ParamInfo[], args: string[]): string | null {
  let out = template;
  for (const [i, p] of params.entries()) {
    const token = `{${p.name}}`;
    if (!out.includes(token)) continue;
    const provided = i < args.length ? argLiteral(args[i]!) : null;
    // A `null`/`undefined`/`''` default is the absence of a value, never one to splice in.
    const fallback = p.defaultValue != null && !NULLISH.test(p.defaultValue.trim()) ? unquote(p.defaultValue) : null;
    let value = provided ?? fallback;
    // A variable argument stands for one path segment — when the template
    // stays specific without it: literal path follows it (`/documents/{}/notes/`),
    // or a base is still to resolve. In `/api/v2/institution/{}/{endpoint}`
    // the variable names the endpoint itself, and `{}` would join any route.
    if (value === null && i < args.length && !NULLISH.test(args[i]!.trim()) && specificWithout(out, token)) value = "{}";
    if (value === null) return null;
    out = out.split(token).join(value);
  }
  return out;
}

const NULLISH = /^(?:null|undefined|''|""|``)$/;

/** `{ slug, host: this.url, kind: 'live' }` → its `key: value` pairs (shorthands name a runtime value: left out). */
function objectArgument(arg: string): Map<string, string> | null {
  if (!arg.startsWith("{") || !arg.endsWith("}")) return null;
  const out = new Map<string, string>();
  for (const part of splitTopLevel(arg.slice(1, -1), ",")) {
    const m = /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

/**
 * A helper taking one destructured object (`({ host, slug }) => `${host}/${slug}/fixtures``):
 * each `${key}` the call states becomes its value — a literal's text, else the
 * expression as a hole the next pass resolves (`${this.url}`).
 */
function substituteNamed(template: string, values: ReadonlyMap<string, string>): string {
  return template.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (hole, key: string) => {
    const v = values.get(key);
    if (v === undefined) return hole;
    const lit = argLiteral(v);
    return lit ?? `\${${v}}`;
  });
}

function specificWithout(template: string, token: string): boolean {
  if (template.includes("${")) return true;
  const after = template.slice(template.indexOf(token) + token.length).replace(/\{[^}]*\}/g, "");
  return /[A-Za-z0-9]/.test(after);
}

/**
 * The templates a call means, by the arguments it passes. A helper that
 * appends optional parts (`if (id) url += `${id}/``) has one template per
 * combination; the call supplying `id` and `action` means the one using both
 * — not the bare collection URL, which would link it to the wrong route.
 */
function chooseTemplates(builder: UrlBuilder, args: string[]): string[] {
  const used = (tpl: string) => new Set(builder.params.filter((p) => tpl.includes(`{${p.name}}`)).map((p) => p.name));
  const universe = new Set(builder.templates.flatMap((t) => [...used(t)]));
  if (universe.size === 0 || builder.templates.length === 1) return builder.templates;
  const supplied = new Set(
    builder.params.filter((p, i) => universe.has(p.name) && i < args.length && !NULLISH.test(args[i]!.trim())).map((p) => p.name),
  );
  const exact = builder.templates.filter((t) => {
    const u = used(t);
    return u.size === supplied.size && [...u].every((n) => supplied.has(n));
  });
  return exact.length > 0 ? exact : builder.templates;
}

function templatesOf(fn: FunctionInfo): string[] {
  return fn.urlTemplate ? [fn.urlTemplate, ...(fn.urlTemplateAlternatives ?? [])] : [];
}

/**
 * Build the project-wide helper index over free functions AND class methods —
 * a data layer's helper is as often `configService.APIUrl(sub)` on a service
 * singleton as a bare `requestUri(sub)`. A name that maps to two genuinely
 * different template sets is ambiguous and dropped (set to null) so we never
 * resolve it the wrong way.
 */
interface HelperLookup {
  /** Helpers by bare name across the project; null = two different ones (ambiguous). */
  global: Map<string, UrlBuilder | null>;
  /** File-local helpers by their dotted name — a route table's `routes.tagsSlug`. */
  local: Map<string, Map<string, UrlBuilder>>;
  /** `this.m(…)`: the method of that name along the calling class's chain. */
  method?: (file: string, line: number, name: string, getterOnly?: boolean) => UrlBuilder | null;
}

function buildIndex(analyses: FileAnalysis[]): Map<string, UrlBuilder | null> {
  const index = new Map<string, UrlBuilder | null>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods)];
    for (const fn of fns) {
      const templates = templatesOf(fn);
      if (templates.length === 0 || fn.name.includes(".")) continue;
      const existing = index.get(fn.name);
      if (existing === undefined) {
        index.set(fn.name, { templates, params: fn.params });
      } else if (existing && existing.templates.join("\n") !== templates.join("\n")) {
        index.set(fn.name, null); // colliding name, divergent template → ambiguous
      }
    }
  }
  return index;
}

// `${ requestUri('x','v4') }` (template substitution) or a bare `requestUri('x','v4')`,
// either optionally behind a receiver chain (`configService.APIUrl('x')`,
// `this.api.url('x')`) that is consumed with the call — the receiver only
// names where the helper lives. The arg group allows one level of nested
// parens so a helper whose argument embeds another call —
// `requestUri(`x/${periodParams(p)}`, 'v1')` — is matched whole instead of
// truncating at the inner `)`.
const ARG = "((?:[^()]|\\([^()]*\\))*)";
const RECEIVER = "((?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*)";
const HELPER_CALL_RE = new RegExp(
  `\\$\\{\\s*${RECEIVER}([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)\\s*\\}|${RECEIVER}([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)`,
  "g",
);

/** Cap on the URL variants one call may fan out to (helpers nested in helpers). */
const MAX_VARIANTS = 8;

interface HelperOccurrence {
  start: number;
  end: number;
  /** The occurrence rewritten through each of the helper's templates. */
  rewrites: string[];
}

/** Where a call sits — which file's route tables and which class's methods it sees. */
interface CallSite {
  file: string;
  line: number;
}

/**
 * The helper a call names: a dotted helper of the call's own file
 * (`routes.tagsSlug(…)`), then — for `this.m(…)` — the method along the
 * calling class's chain, then a helper of that bare name anywhere (unless two
 * differ).
 */
function lookupHelper(lookup: HelperLookup, site: CallSite, receiver: string, name: string): UrlBuilder | null {
  const recv = receiver.replace(/\s+/g, "").replace(/\.$/, "");
  if (recv) {
    const local = lookup.local.get(site.file)?.get(`${recv}.${name}`);
    if (local) return local;
  }
  if (recv === "this" && lookup.method) {
    const own = lookup.method(site.file, site.line, name);
    if (own) return own;
  }
  return lookup.global.get(name) ?? null;
}

// `${this.url}` — a read of a getter (or no-argument method body) the calling class defines.
const GETTER_READ_RE = /\$\{\s*this\s*\.\s*([A-Za-z_$][\w$]*)\s*\}/g;

/** The first helper call in `text` that the index can resolve, or null. */
function firstResolvable(text: string, lookup: HelperLookup, site: CallSite): HelperOccurrence | null {
  if (lookup.method && text.includes("${this.")) {
    for (const m of text.matchAll(GETTER_READ_RE)) {
      const getter = lookup.method(site.file, site.line, m[1]!, true);
      if (!getter || getter.params.length > 0) continue;
      return { start: m.index!, end: m.index! + m[0].length, rewrites: getter.templates };
    }
  }
  for (const m of text.matchAll(HELPER_CALL_RE)) {
    const inTemplate = m[2] != null;
    const receiver = (inTemplate ? m[1] : m[4]) ?? "";
    const name = (inTemplate ? m[2] : m[5]) as string;
    const argsText = (inTemplate ? m[3] : m[6]) as string;
    const builder = lookupHelper(lookup, site, receiver, name);
    if (!builder) continue; // unknown or ambiguous — leave verbatim
    const args = splitTopLevel(argsText, ",").map((a) => a.trim()).filter((a) => a.length > 0);
    const named = builder.params.length === 0 && args.length === 1 ? objectArgument(args[0]!) : null;
    const rewrites = named
      ? builder.templates.map((tpl) => substituteNamed(tpl, named))
      : chooseTemplates(builder, args).map((tpl) => substitute(tpl, builder.params, args));
    if (rewrites.some((r) => r === null)) continue; // a bare-variable arg — leave verbatim
    return { start: m.index!, end: m.index! + m[0].length, rewrites: rewrites as string[] };
  }
  return null;
}

/**
 * Rewrite every resolvable helper call inside one target string. A helper
 * with several templates fans the target out into one variant per template,
 * primary first; variants are deduplicated and capped at {@link MAX_VARIANTS}.
 */
function resolveTargets(target: string, lookup: HelperLookup, site: CallSite): string[] {
  let variants = [target];
  for (let pass = 0; pass < MAX_VARIANTS; pass++) {
    const next: string[] = [];
    let changed = false;
    for (const v of variants) {
      const occ = firstResolvable(v, lookup, site);
      if (!occ) {
        next.push(v);
        continue;
      }
      changed = true;
      for (const r of occ.rewrites) {
        const rewritten = v.slice(0, occ.start) + r + v.slice(occ.end);
        if (!next.includes(rewritten)) next.push(rewritten);
      }
    }
    variants = next.slice(0, MAX_VARIANTS);
    if (!changed) break;
  }
  return variants;
}

/**
 * Resolve URL-builder helper calls in every api-call target. Mutates the targets
 * in place (`target` = primary branch, `targetAlternatives` = the others) and
 * returns the number rewritten. No-op when the project defines no URL-builder
 * helpers.
 */
export function resolveUrlBuilders(apiCalls: ApiCall[], analyses: FileAnalysis[], ctx?: ProjectContext): number {
  const lookup: HelperLookup = { global: buildIndex(analyses), local: localHelpers(analyses) };
  if (ctx) lookup.method = methodResolver(ctx);
  if (lookup.global.size === 0 && lookup.local.size === 0 && !lookup.method) return 0;
  let count = 0;
  for (const call of apiCalls) {
    if (call.kind !== "api-call" || !call.target) continue;
    // A helper call always has `(`; a getter read is `${this.x}`.
    if (!call.target.includes("(") && !(lookup.method && call.target.includes("${this."))) continue;
    const [primary, ...rest] = resolveTargets(call.target, lookup, { file: call.filePath, line: call.line });
    if (primary !== undefined && primary !== call.target) {
      call.target = primary;
      if (rest.length > 0) call.targetAlternatives = rest;
      count++;
    }
  }
  return count;
}

/** Each file's dotted helpers (`routes.tagsSlug: (tag) => `${prefix}/tags/slug/${tag}``). */
function localHelpers(analyses: FileAnalysis[]): Map<string, Map<string, UrlBuilder>> {
  const out = new Map<string, Map<string, UrlBuilder>>();
  for (const a of analyses) {
    for (const fn of a.functions) {
      if (!fn.name.includes(".")) continue;
      const templates = templatesOf(fn);
      if (templates.length === 0) continue;
      const map = out.get(a.filePath) ?? new Map<string, UrlBuilder>();
      map.set(fn.name, { templates, params: fn.params });
      out.set(a.filePath, map);
    }
  }
  return out;
}

/**
 * `this.m(…)` → the first `m` along the calling class's chain, with its
 * templates (or nothing when it has none). A template whose leading runtime
 * base the extractor dropped (`${this.baseUrl()}/${this.resource}`) gets that
 * base back, so the next pass resolves it through the same chain instead of
 * the URL losing its prefix. `getterOnly` answers a property read (`this.url`):
 * only a getter is read that way.
 */
function methodResolver(ctx: ProjectContext): (file: string, line: number, name: string, getterOnly?: boolean) => UrlBuilder | null {
  return (file, line, name, getterOnly) => {
    let cls: ClassRef | null = null;
    for (const ref of ctx.classes.classesIn(file)) {
      if (ref.cls.line <= line && line <= ref.cls.endLine && (!cls || ref.cls.line >= cls.cls.line)) cls = ref;
    }
    if (!cls) return null;
    for (const c of [cls, ...ctx.classes.ancestors(cls).flatMap((s) => (s.ref ? [s.ref] : []))]) {
      const fn = c.cls.methods.find((m) => m.name === name);
      if (!fn) {
        // A field of that name shadows nothing further up for a property read.
        if (getterOnly && c.cls.properties?.some((p) => p.name === name)) return null;
        continue;
      }
      // No getter flag is kept; a property read of a method only makes sense for one.
      if (getterOnly && fn.params.length > 0) return null;
      const templates = templatesOf(fn).map((t) => (fn.urlTemplateBase ? `\${${fn.urlTemplateBase}}${t}` : t));
      return templates.length > 0 ? { templates, params: fn.params } : null;
    }
    return null;
  };
}
