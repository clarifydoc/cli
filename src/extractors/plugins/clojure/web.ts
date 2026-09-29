import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Clojure web routes and data sources — both were completely dark.
 *
 * Routes live in `routes.ts` (Compojure lists and reitit vectors, read from
 * the form tree in `forms.ts`, with their bindings and guards) and are
 * re-exported here.
 *
 * Data sources:
 *   - next.jdbc / clojure.java.jdbc carry raw SQL in double-quoted strings —
 *     the shared SQL-in-strings scanner reads them directly (`;` comment
 *     lines are blanked first; the scanner only knows C-style comments).
 *   - HoneySQL keyword maps name the table outright (`:from [:users]`).
 *   - clj-http `(http/get "https://…")` → api-call; `(System/getenv "X")` → env.
 */

export { extractClojureRoutes } from "./routes.js";

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
