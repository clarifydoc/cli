/**
 * Language-agnostic symbolic value resolver — the shared "fold" half of value
 * reconstruction.
 *
 * The engine repeatedly needs to reconstruct a mostly-static string (a request
 * URL, an SQL/table name) that a program assembles from pieces:
 *
 *   const url = base + '/api/' + version + '/users/' + id;   // JS
 *   url = "#{ENV['API']}/orders/#{id}"                       // Ruby
 *
 * Historically each plugin grew its own single-hop, literal-only folder, so a
 * value built by concatenation across several local assignments never resolved.
 * This module factors out the part that is genuinely language-agnostic: given a
 * small **value expression IR** ({@link ValueExpr}) captured from the native
 * syntax by a plugin, {@link foldValue} partially evaluates it — folding
 * concatenations and template pieces, chasing local `ref` bindings multi-hop
 * (with a cycle guard), and reducing what it cannot know to a stable hole. The
 * output uses the same `{param}` / `{env:NAME}` / `{}` hole convention that
 * `FunctionInfo.urlTemplate` already speaks and that
 * `normalizeRoutePath` (route-linker) already collapses to a `{}` wildcard, so a
 * folded value drops straight into the existing frontend→API→DB join.
 *
 * Only the *fold* lives here. *Capture* (native AST / source text → `ValueExpr`)
 * is inherently syntactic and stays in each plugin. This is a leaf module: it
 * may import only shared types, never the registry or core.
 */

import type { Confidence } from "../../types/analysis.js";
import { BEST_RANK } from "./confidence.js";

/**
 * A captured value expression. `lit` carries already-unquoted content for a
 * plain string, or the raw fragment text for a template piece (capture decides).
 * Holes: `param` (a function parameter → `{name}`), `env` (an environment
 * variable read → `{env:NAME}`), `ref` (an identifier resolved through a
 * {@link Scope}), and `opaque` (a member access / call / anything runtime → `{}`,
 * keeping its source text for the rare verbatim mode).
 */
export type ValueExpr =
  | { kind: "lit"; value: string }
  | { kind: "concat"; parts: ValueExpr[] }
  | { kind: "template"; parts: ValueExpr[] }
  // A `??` / `||` fallback chain (parts in evaluation order): folds to the first
  // part that resolves to a fully-literal string, else the first non-null part.
  // Captures the ubiquitous env-default idiom `import.meta.env.X ?? '/path'`.
  | { kind: "coalesce"; parts: ValueExpr[] }
  | { kind: "ref"; name: string }
  | { kind: "param"; name: string }
  | { kind: "env"; name: string }
  | { kind: "opaque"; text: string };

/**
 * In-scope bindings for {@link foldValue}. A `null` value marks a **conflicting**
 * binding — a name assigned two divergent values in scope — so folding it yields
 * a `{}` hole and downgrades to AMBIGUOUS rather than guessing one of them (the
 * same "ambiguous → drop, never guess" discipline used across the linkers).
 */
export type Scope = ReadonlyMap<string, ValueExpr | null>;

export interface FoldOptions {
  /** Names to treat as parameters (a `ref` to one renders `{name}`). */
  params?: ReadonlySet<string>;
  /**
   * How an `env` hole renders: `"name"` → `{env:NAME}` (default; the base can be
   * recovered later via {@link toAppRelativeUrl}); `"collapse"` → `""` (drop it
   * inline, for callers that want an app-relative path directly).
   */
  envMode?: "name" | "collapse";
  /**
   * How an `opaque` hole renders: `"hole"` → `{}` (default); `"keep"` → its
   * source text verbatim (used when a later pass will still substitute it, e.g.
   * a URL-builder helper call kept for project-level resolution).
   */
  opaqueCall?: "hole" | "keep" | "template";
  /**
   * How an identifier with no binding in scope renders: `"hole"` → `{}`
   * (default); `"template"` → `${name}`, so a project pass that knows the
   * module or class it comes from can still fill it in.
   */
  unknownRef?: "hole" | "template";
  /**
   * With `opaqueCall: "template"`, which opaque pieces stay `${…}` — the ones
   * a later pass could resolve (a field, an imported name); the rest are `{}`.
   * Default: all.
   */
  keepHole?: (text: string) => boolean;
  /** Ref-chain depth guard (default 16). */
  maxDepth?: number;
}

export interface FoldResult {
  /**
   * The folded value with `{param}` / `{env:NAME}` / `{}` holes, or `null` when
   * the expression is genuinely unresolvable (a ref cycle or a missing node).
   */
  text: string | null;
  /**
   * Provenance: EXTRACTED when fully literal, INFERRED once any hole appears,
   * AMBIGUOUS when a conflicting binding was hit.
   */
  confidence: Confidence;
  /** Whether the result contains at least one hole. */
  hadHole: boolean;
}

const EMPTY_PARAMS: ReadonlySet<string> = new Set();

/**
 * Partially evaluate a captured {@link ValueExpr} against a {@link Scope}.
 *
 * Multi-hop by construction: a `ref` resolves through the scope and recurses,
 * guarded by a per-fold visited-name set (breaks `a = b; b = a`) and `maxDepth`.
 * A `concat` fails (returns `null`) if any part is unresolvable — matching the
 * legacy string-concat folders — while a `template` substitutes a `{}` for an
 * unresolvable piece so an otherwise-known template still yields a usable path.
 */
export function foldValue(expr: ValueExpr, scope: Scope, opts: FoldOptions = {}): FoldResult {
  const params = opts.params ?? EMPTY_PARAMS;
  const envMode = opts.envMode ?? "name";
  const opaqueMode = opts.opaqueCall ?? "hole";
  const unknownRefMode = opts.unknownRef ?? "hole";
  const maxDepth = opts.maxDepth ?? 16;

  let hadHole = false;
  let confidence: Confidence = "EXTRACTED";
  const downgrade = (c: Confidence): void => {
    if (BEST_RANK[c] < BEST_RANK[confidence]) confidence = c;
  };
  const hole = (rendered: string, conf: Confidence = "INFERRED"): string => {
    hadHole = true;
    downgrade(conf);
    return rendered;
  };

  const visited = new Set<string>();

  const go = (e: ValueExpr, depth: number): string | null => {
    if (depth > maxDepth) return hole("{}");
    switch (e.kind) {
      case "lit":
        return e.value;
      case "concat": {
        let out = "";
        for (const p of e.parts) {
          const r = go(p, depth + 1);
          if (r === null) return null; // unresolvable concat → whole value fails
          out += r;
        }
        return out;
      }
      case "template": {
        let out = "";
        for (const p of e.parts) {
          const r = go(p, depth + 1);
          out += r ?? hole("{}"); // a template survives an unresolvable piece
        }
        return out;
      }
      case "coalesce": {
        // Prefer a fully-literal operand (the env-default string); else the first
        // that resolves at all. Each operand is folded in isolation so one part's
        // holes don't leak when a cleaner alternative exists.
        let fallback: string | null = null;
        for (const p of e.parts) {
          const sub = foldValue(p, scope, {
            params,
            envMode,
            opaqueCall: opaqueMode,
            unknownRef: unknownRefMode,
            ...(opts.keepHole ? { keepHole: opts.keepHole } : {}),
            maxDepth: Math.max(0, maxDepth - depth),
          });
          if (sub.text !== null && !sub.hadHole) return sub.text; // fully literal
          if (fallback === null && sub.text !== null) fallback = sub.text;
        }
        if (fallback !== null) return hole(fallback);
        return null;
      }
      case "param":
        return hole(`{${e.name}}`);
      case "env":
        return hole(envMode === "collapse" ? "" : `{env:${e.name}}`);
      case "opaque":
        return hole(
          opaqueMode === "keep"
            ? e.text
            : opaqueMode === "template" && (opts.keepHole?.(e.text) ?? true)
              ? `\${${e.text.replace(/\s+/g, "")}}`
              : "{}",
        );
      case "ref": {
        if (params.has(e.name)) return hole(`{${e.name}}`);
        if (visited.has(e.name)) return null; // cycle
        if (!scope.has(e.name)) return hole(unknownRefMode === "template" ? `\${${e.name}}` : "{}"); // unknown identifier
        const bound = scope.get(e.name);
        if (bound == null) return hole("{}", "AMBIGUOUS"); // conflicting binding
        visited.add(e.name);
        const r = go(bound, depth + 1);
        visited.delete(e.name);
        return r;
      }
    }
  };

  return { text: go(expr, 0), confidence, hadHole };
}

/**
 * Split `text` on a top-level occurrence of `sep`, respecting quote/backtick
 * spans and bracket nesting so a separator inside a string literal or a nested
 * group doesn't split it. Shared by the URL-builder call-site splitter and the
 * Ruby concat capture (previously three near-identical copies).
 */
export function splitTopLevel(text: string, sep: string): string[] {
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

/** Strip one layer of matching quotes/backticks from a literal's text. */
export function unquote(s: string): string {
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
 * Render a folded value as an app-relative URL, recovering a leading *placeholder*
 * base.
 *
 * The keystone route join needs an app-relative path (`/api/v2/users/{}`). A
 * value folded with `envMode: "name"` keeps a non-literal base as a leading
 * token — `{env:VITE_API}/api/x` (an environment read) or an unresolved
 * `{}/api/x` (a runtime variable) — which this strips so the path joins,
 * returning the env var name when the base was an environment read. An INTERIOR
 * `{env:NAME}` is left untouched — `normalizeRoutePath` already collapses it to a
 * `{}` wildcard, so it cannot regress a match.
 *
 * A *literal* absolute URL (`https://host/x`) is deliberately left as-is: it may
 * be a genuinely external endpoint, and the downstream join already treats
 * absolute URLs as non-joinable — stripping the host here would fabricate joins.
 */
export function toAppRelativeUrl(text: string): { url: string; baseEnv?: string } {
  const s = text.trim();
  // Leading `{env:NAME}` base immediately before the path.
  const envMatch = s.match(/^\{env:([^}]+)\}(?=\/)/);
  if (envMatch) {
    return { url: s.slice(envMatch[0].length), baseEnv: envMatch[1] };
  }
  // Leading unresolved `{}` base before an app-relative path (`{}/api/x` → `/api/x`).
  if (s.startsWith("{}/")) return { url: s.slice(2) };
  return { url: s };
}
