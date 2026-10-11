import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";
import { asDoubleQuotedLiteral, extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Haxe data access: SQL in strings (`cnx.request("SELECT …")` on a
 * `sys.db.Connection`) — a single-quoted string interpolates (`'… $id'`)
 * and is read the same — and HTTP with a literal URL: `new haxe.Http("…")`,
 * `Http.requestUrl("…")`, `fetch("/api/…")` on the JS target.
 */
export function extractHaxeDataSources(lines: string[], _classes: ClassInfo[]): DataSourceInfo[] {
  const sqlLines = lines.map((l) =>
    l.replace(/'((?:[^'\\]|\\.)*)'/g, (all, body: string) => (/\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(body) ? asDoubleQuotedLiteral(body.replace(/\$\{?(\w+)\}?/g, "?")) : all)),
  );
  const out = extractSqlStringDataSources(sqlLines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const push = (method: string, url: string) => {
      const target = url.replace(/\$\{?(\w+)\}?/g, "{$1}");
      if (/^(?:https?:\/\/|\/)/.test(target)) out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line: i + 1 });
    };
    for (const m of line.matchAll(/new\s+(?:haxe\.|sys\.)?Http\s*\(\s*["']([^"']+)["']/g)) push(/\.request\s*\(\s*true\s*\)/.test(lines.slice(i, i + 6).join(" ")) ? "POST" : "GET", m[1]!);
    for (const m of line.matchAll(/\bHttp\.requestUrl\s*\(\s*["']([^"']+)["']/g)) push("GET", m[1]!);
    for (const m of line.matchAll(/\bfetch\s*\(\s*["']([^"']+)["'](?:\s*,\s*\{[^}]*method\s*:\s*["'](\w+)["'])?/g)) push((m[2] ?? "GET").toUpperCase(), m[1]!);
  }
  return out.sort((a, b) => a.line - b.line);
}
