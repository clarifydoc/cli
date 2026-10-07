import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { nimSqlLines } from "./source.js";

/**
 * HTTP calls a Nim program makes:
 *
 *  - `std/httpclient`: `client.getContent("https://…")`, `postContent`,
 *    `putContent`, `patchContent`, `deleteContent`, `request(url, HttpPost)` /
 *    `httpMethod = HttpPost`, `downloadFile`, and `get` / `post` / … on a
 *    client (a receiver named like one, or an absolute URL).
 *  - Karax frontends (compiled to JavaScript): `ajaxGet(makeUri("/x"), …)`,
 *    `ajaxPost(uri, …)` with `uri` bound in the same routine to a literal or a
 *    `makeUri(…)` of one. A relative `makeUri("threads.json")` names the
 *    app-relative `/threads.json`; a query string is not part of the path.
 *
 * SQL in strings is read from the raw source by `extractNimSqlSources`.
 */
export function extractNimDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, target: string | null, line: number) => {
    if (!target || (!target.startsWith("/") && !/^https?:\/\//i.test(target))) return;
    out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line });
  };
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(/\.(getContent|postContent|putContent|patchContent|deleteContent|downloadFile)\s*\(\s*("[^"]*"(?:\s*&\s*[^,)]+)*)/g)) {
      push(CONTENT_VERB[m[1]!]!, urlOf(m[2]!), i + 1);
    }
    for (const m of line.matchAll(/\.request\s*\(\s*(?:url\s*=\s*)?("[^"]*"(?:\s*&\s*[^,)]+)*)([^)]*)/g)) {
      push(/\bHttp(Get|Post|Put|Patch|Delete|Head|Options)\b/.exec(m[2]!)?.[1]?.toUpperCase() ?? "GET", urlOf(m[1]!), i + 1);
    }
    for (const m of line.matchAll(/\b([A-Za-z_]\w*)\.(get|post|put|patch|delete|head)\s*\(\s*("[^"]*")/g)) {
      const url = urlOf(m[3]!);
      if (/client|http/i.test(m[1]!) || /^https?:\/\//i.test(url ?? "")) push(m[2]!.toUpperCase(), url, i + 1);
    }
    for (const m of line.matchAll(/\bajax(Get|Post|Put|Delete|Patch)\s*\(\s*([^,)]+(?:\([^)]*\))?)/g)) {
      push(m[1]!.toUpperCase(), karaxUri(m[2]!.trim(), lines, i), i + 1);
    }
  });
  return out;
}

const CONTENT_VERB: Record<string, string> = {
  getContent: "GET", postContent: "POST", putContent: "PUT", patchContent: "PATCH", deleteContent: "DELETE", downloadFile: "GET",
};

/**
 * A URL written as a literal or a `&`-concatenation of literals and names:
 * `"/about/" & page & ".html"` → `/about/{page}.html`, `$t.id` → `{id}`.
 */
function urlOf(expr: string): string | null {
  const parts = expr.split(/\s*&\s*/);
  if (!/^"/.test(parts[0]!.trim())) return null;
  let url = "";
  for (const raw of parts) {
    const part = raw.trim();
    const lit = /^"([^"]*)"$/.exec(part);
    if (lit) url += lit[1];
    else {
      const name = /([A-Za-z_]\w*)\s*\)*$/.exec(part)?.[1];
      if (!name) break;
      url += `{${name}}`;
    }
  }
  return url.replace(/[?#].*$/, "") || null;
}

/** The URL an `ajaxGet` argument names: a literal, `makeUri(…)` of one, or a local bound to either above it. */
function karaxUri(arg: string, lines: string[], at: number): string | null {
  const direct = /^(?:makeUri\s*\(\s*)?("[^"]*"(?:\s*&\s*[^,)]+)*)/.exec(arg);
  let expr = direct?.[1];
  if (!expr && /^[A-Za-z_]\w*$/.test(arg)) {
    const bind = new RegExp(String.raw`\b${arg}\s*(?::[^=]*)?=\s*(?:makeUri\s*\(\s*)?("[^"]*"(?:\s*&\s*[^,)]+)*)`);
    for (let j = at; j >= Math.max(0, at - 20) && !expr; j--) expr = bind.exec(lines[j]!)?.[1];
  }
  if (!expr) return null;
  const url = urlOf(expr);
  if (!url || /^https?:\/\//i.test(url)) return url;
  return url.startsWith("/") ? url : `/${url}`;
}

/** SQL statements in the file's strings, `"""…"""` blocks included (raw source). */
export function extractNimSqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(nimSqlLines(rawLines));
}
