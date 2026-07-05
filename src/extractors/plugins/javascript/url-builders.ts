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
 *   axios.get(requestUri('vikarbesked', 'v4'))   // → /api/v4/institution/{}/vikarbesked
 *
 * The per-file extractor captures the helper's parameterized template
 * (`FunctionInfo.urlTemplate`) and the call site's api-call target verbatim
 * (`requestUri('vikarbesked', 'v4')`, or `` `${requestUri(...)}/${id}` ``). This
 * pass builds a project-wide helper index and substitutes each call site's
 * literal arguments into the matching template, so the api-call carries a
 * concrete app-relative URL that {@link linkApiCallsToRoutes} can join to the
 * backend route. The helper definition and its call sites are almost always in
 * different files, so this must run after per-file analysis (it mirrors
 * `resolveExpressMounts` / `detectFileBasedRoutes`).
 *
 * Operates on the aggregated api-call list in memory; per-file JSON is untouched.
 */

import type { DataSourceInfo, FileAnalysis, ParamInfo } from "../../../types/analysis.js";

interface UrlBuilder {
  template: string;
  params: ParamInfo[];
}

type ApiCall = DataSourceInfo & { filePath: string };

/** Strip one layer of matching quotes/backticks from a literal's text. */
function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === "'" || q === '"' || q === "`") && t[t.length - 1] === q) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/**
 * Split text on a top-level separator (`,` for an arg list, `+` for a concat),
 * respecting quote/backtick spans and bracket nesting so a separator inside a
 * string literal or a nested group doesn't split it.
 */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      cur += ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      cur += ch;
    } else if (ch === sep && depth === 0) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim().length > 0) out.push(cur);
  return out;
}

/**
 * Resolve one call argument to a path fragment. A bare string/template literal
 * yields its content; a concatenation (`'aktiviteter/' + x.externalId`) keeps
 * its literal segments and reduces each runtime part to a `{}` wildcard so the
 * path still matches a parameterized route. A single non-literal (a bare
 * variable holding the whole value) returns null so a parameter default can fill
 * in instead (e.g. a version arg).
 */
function argLiteral(raw: string): string | null {
  const parts = splitTop(raw, "+");
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

/** Substitute a call's literal args into a builder's `{param}` template tokens. */
function substitute(builder: UrlBuilder, args: string[]): string {
  let out = builder.template;
  builder.params.forEach((p, i) => {
    const provided = i < args.length ? argLiteral(args[i]!) : null;
    const fallback = p.defaultValue != null ? unquote(p.defaultValue) : null;
    const value = provided ?? fallback ?? "{}";
    out = out.split(`{${p.name}}`).join(value);
  });
  return out;
}

/**
 * Build the project-wide helper index. A name that maps to two genuinely
 * different templates is ambiguous and dropped (set to null) so we never resolve
 * it the wrong way.
 */
function buildIndex(analyses: FileAnalysis[]): Map<string, UrlBuilder | null> {
  const index = new Map<string, UrlBuilder | null>();
  for (const a of analyses) {
    if (a.language !== "typescript" && a.language !== "javascript") continue;
    for (const fn of a.functions) {
      if (!fn.urlTemplate) continue;
      const existing = index.get(fn.name);
      if (existing === undefined) {
        index.set(fn.name, { template: fn.urlTemplate, params: fn.params });
      } else if (existing && existing.template !== fn.urlTemplate) {
        index.set(fn.name, null); // colliding name, divergent template → ambiguous
      }
    }
  }
  return index;
}

// `${ requestUri('x','v4') }` (template substitution) or a bare `requestUri('x','v4')`.
// The arg group allows one level of nested parens so a helper whose argument
// embeds another call — `requestUri(`x/${periodParams(p)}`, 'v1')` — is matched
// whole instead of truncating at the inner `)`.
const ARG = "((?:[^()]|\\([^()]*\\))*)";
const HELPER_CALL_RE = new RegExp(
  `\\$\\{\\s*([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)\\s*\\}|([A-Za-z_$][\\w$]*)\\s*\\(${ARG}\\)`,
  "g",
);

/** Rewrite any resolvable helper calls inside one target string. */
function resolveTarget(target: string, index: Map<string, UrlBuilder | null>): string {
  return target.replace(HELPER_CALL_RE, (whole, wName, wArgs, bName, bArgs) => {
    const name = (wName ?? bName) as string;
    const argsText = (wName != null ? wArgs : bArgs) as string;
    const builder = index.get(name);
    if (!builder) return whole; // unknown or ambiguous — leave verbatim
    return substitute(builder, splitTop(argsText, ","));
  });
}

/**
 * Resolve URL-builder helper calls in every api-call target. Mutates the targets
 * in place and returns the number rewritten. No-op when the project defines no
 * URL-builder helpers.
 */
export function resolveUrlBuilders(apiCalls: ApiCall[], analyses: FileAnalysis[]): number {
  const index = buildIndex(analyses);
  if (index.size === 0) return 0;
  let count = 0;
  for (const call of apiCalls) {
    if (call.kind !== "api-call" || !call.target) continue;
    if (!call.target.includes("(")) continue; // a helper call always has `(`
    const resolved = resolveTarget(call.target, index);
    if (resolved !== call.target) {
      call.target = resolved;
      count++;
    }
  }
  return count;
}
