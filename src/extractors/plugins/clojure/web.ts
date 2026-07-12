import type { DataSourceInfo, RouteInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Clojure web routes and data sources — both were completely dark.
 *
 * Routes:
 *   - Compojure: `(GET "/users/:id" [id] (get-user id))`, with
 *     `(context "/api" [] …)` prefixes stacked by paren depth (this is the
 *     regex path — no AST — so depth is counted per line outside strings).
 *   - reitit (vector DSL): `["/users/:id" {:get get-user :post save-user}]`.
 *
 * Data sources:
 *   - next.jdbc / clojure.java.jdbc carry raw SQL in double-quoted strings —
 *     the shared SQL-in-strings scanner reads them directly (`;` comment
 *     lines are blanked first; the scanner only knows C-style comments).
 *   - HoneySQL keyword maps name the table outright (`:from [:users]`).
 *   - clj-http `(http/get "https://…")` → api-call; `(System/getenv "X")` → env.
 */

const COMPOJURE_RE = /\(\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+"([^"]+)"/;
/** Handler: first called symbol after the binding vector on the same line. */
const COMPOJURE_HANDLER_RE = /\]\s*\(\s*([\w.!?<>=*+-]+[\w.!?<>=*+/-]*)/;
const CONTEXT_RE = /\(\s*context\s+"([^"]+)"/;
/** reitit: `["/path" {:get handler}]` — one route per verb key. */
const REITIT_RE = /\[\s*"(\/[^"]*)"\s*\{([^}]*)\}/;
const REITIT_VERB_RE = /:(get|post|put|patch|delete|head|options)\s+([\w.!?*+-]+[\w.!?*+/-]*)?/g;

function parenDelta(line: string): number {
  const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/;.*$/, "");
  let d = 0;
  for (const ch of stripped) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
  }
  return d;
}

function joinPath(prefixes: string[], path: string): string {
  const parts = [...prefixes, path].join("/").split("/").filter(Boolean);
  return "/" + parts.join("/");
}

export function extractClojureRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const contextStack: Array<{ depth: number; prefix: string }> = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (/^\s*;/.test(line)) continue;

    const ctx = line.match(CONTEXT_RE);
    if (ctx) {
      contextStack.push({ depth: depth + parenDelta(line), prefix: ctx[1]! });
      depth += parenDelta(line);
      continue;
    }

    const prefixes = contextStack.map((c) => c.prefix);

    const comp = line.match(COMPOJURE_RE);
    if (comp) {
      routes.push({
        path: joinPath(prefixes, comp[2]!),
        httpMethod: comp[1] === "ANY" ? null : comp[1]!,
        kind: "api",
        handler: line.match(COMPOJURE_HANDLER_RE)?.[1] ?? null,
        calls: [],
        middleware: [],
        line: lineNo,
      });
    } else {
      const reitit = line.match(REITIT_RE);
      if (reitit) {
        REITIT_VERB_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = REITIT_VERB_RE.exec(reitit[2]!)) !== null) {
          routes.push({
            path: joinPath(prefixes, reitit[1]!),
            httpMethod: m[1]!.toUpperCase(),
            kind: "api",
            handler: m[2] && m[2] !== "handler" ? m[2] : null,
            calls: [],
            middleware: [],
            line: lineNo,
          });
        }
      }
    }

    depth += parenDelta(line);
    while (contextStack.length > 0 && depth < contextStack[contextStack.length - 1]!.depth) {
      contextStack.pop();
    }
  }

  return routes;
}

// ─── Data sources ────────────────────────────────────────────────────────────

/** HoneySQL table keywords: `:from [:users]`, `:insert-into :orders`, … */
const HONEYSQL_RE = /:(from|insert-into|update|delete-from|join)\s+\[?:([\w-]+)/;
const CLJ_HTTP_RE = /\(\s*(?:clj-http\.client|http|client)\/(get|post|put|patch|delete|head)\s+"([^"]+)"/;
const GETENV_RE = /\(\s*System\/getenv\s+"([^"]+)"/;

export function extractClojureDataSources(lines: string[]): DataSourceInfo[] {
  // The shared scanner treats `//`-style comments; blank Clojure's `;` lines.
  const sqlLines = lines.map((l) => (/^\s*;/.test(l) ? "" : l));
  const sources: DataSourceInfo[] = extractSqlStringDataSources(sqlLines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*;/.test(line)) continue;
    const lineNo = i + 1;

    const honey = line.match(HONEYSQL_RE);
    if (honey) {
      sources.push({
        kind: "database",
        name: `honeysql: ${honey[1]}`,
        target: honey[2]!,
        entity: honey[2]!,
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const http = line.match(CLJ_HTTP_RE);
    if (http) {
      sources.push({ kind: "api-call", name: http[1]!.toUpperCase(), target: http[2]!, calls: [], line: lineNo });
      continue;
    }

    const env = line.match(GETENV_RE);
    if (env) {
      sources.push({ kind: "env", name: "System/getenv", target: env[1]!, calls: [], line: lineNo });
    }
  }

  return sources;
}
