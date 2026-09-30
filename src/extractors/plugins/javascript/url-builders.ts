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
    const fallback = p.defaultValue != null ? unquote(p.defaultValue) : null;
    const value = provided ?? fallback;
    if (value === null) return null;
    out = out.split(token).join(value);
  }
  return out;
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
function buildIndex(analyses: FileAnalysis[]): Map<string, UrlBuilder | null> {
  const index = new Map<string, UrlBuilder | null>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    const fns = [...a.functions, ...a.classes.flatMap((c) => c.methods)];
    for (const fn of fns) {
      const templates = templatesOf(fn);
      if (templates.length === 0) continue;
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
const RECEIVER = "(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)*";
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

/** The first helper call in `text` that the index can resolve, or null. */
function firstResolvable(text: string, index: Map<string, UrlBuilder | null>): HelperOccurrence | null {
  for (const m of text.matchAll(HELPER_CALL_RE)) {
    const name = (m[1] ?? m[3]) as string;
    const argsText = (m[1] != null ? m[2] : m[4]) as string;
    const builder = index.get(name);
    if (!builder) continue; // unknown or ambiguous — leave verbatim
    const args = splitTopLevel(argsText, ",");
    const rewrites = builder.templates.map((tpl) => substitute(tpl, builder.params, args));
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
function resolveTargets(target: string, index: Map<string, UrlBuilder | null>): string[] {
  let variants = [target];
  for (let pass = 0; pass < MAX_VARIANTS; pass++) {
    const next: string[] = [];
    let changed = false;
    for (const v of variants) {
      const occ = firstResolvable(v, index);
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
export function resolveUrlBuilders(apiCalls: ApiCall[], analyses: FileAnalysis[]): number {
  const index = buildIndex(analyses);
  if (index.size === 0) return 0;
  let count = 0;
  for (const call of apiCalls) {
    if (call.kind !== "api-call" || !call.target) continue;
    if (!call.target.includes("(")) continue; // a helper call always has `(`
    const [primary, ...rest] = resolveTargets(call.target, index);
    if (primary !== undefined && primary !== call.target) {
      call.target = primary;
      if (rest.length > 0) call.targetAlternatives = rest;
      count++;
    }
  }
  return count;
}
