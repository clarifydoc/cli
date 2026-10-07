import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * PowerShell data access:
 *
 *  - HTTP: `Invoke-RestMethod` / `Invoke-WebRequest` (and `irm` / `iwr`) with
 *    `-Uri` (or the first positional string) and `-Method`; a URL built on a
 *    variable keeps its literal tail (`"$base/users/$id"` → `/users/{id}`).
 *  - SQL: any SQL statement in a string — `Invoke-Sqlcmd -Query "…"`,
 *    `$cmd.CommandText = "…"`, a here-string — read from the RAW source by
 *    `extractPowerShellSqlSources`, since the spec sees here-strings blanked.
 */
export function extractPowerShellDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    if (!/\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b/i.test(text)) continue;
    for (let j = i; /`\s*$/.test(lines[j]!) && j + 1 < lines.length; j++) text = text.replace(/`\s*$/, " ") + lines[j + 1];
    const call = /\b(?:Invoke-RestMethod|Invoke-WebRequest|irm|iwr)\b(.*)$/i.exec(text)![1]!;
    const uri = /-Uri\s+(["'])([^"']+)\1/i.exec(call)?.[2] ?? /^\s+(["'])([^"']+)\1/.exec(call)?.[2];
    if (!uri) continue;
    const target = urlTarget(uri);
    if (!target) continue;
    const method = (/-Method\s+["']?(\w+)/i.exec(call)?.[1] ?? "GET").toUpperCase();
    const source: DataSourceInfo = { kind: "api-call", name: `${method} ${target}`, target, calls: [], line: i + 1 };
    const env = /^\$env:(\w+)\//i.exec(uri)?.[1];
    if (env) source.baseEnv = env;
    out.push(source);
  }
  return out;
}

/**
 * `"$BaseUrl/users/$($user.Id)"` / `"$env:CRM_URL/users"` → `/users/{id}` /
 * `/users` (the base is configuration); a literal `https://…` / `/…` URL as
 * written.
 */
function urlTarget(uri: string): string | null {
  let t = uri.replace(/^\$(?:env:\w+|\{[^}]+\}|\([^)]*\)|\w+)(?=\/)/i, "");
  t = t.replace(/\$\(\s*\$?[\w.]*?(\w+)\s*\)/g, "{$1}").replace(/\$\{?(\w+)\}?/g, "{$1}");
  t = t.replace(/\{(\w+)\}/g, (_m, v: string) => `{${v.charAt(0).toLowerCase()}${v.slice(1)}}`);
  return t.startsWith("/") || /^https?:\/\//i.test(t) ? t : null;
}

/** SQL statements in the file's strings (raw source, here-strings included). */
export function extractPowerShellSqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(powershellSqlLines(rawLines));
}

/**
 * PowerShell source in the C-like shape the shared SQL scanner reads: each
 * `"…"` / `'…'` string (backtick and doubled-quote escapes) and each line of
 * a `@"…"@` / `@'…'@` here-string as one `"…"` literal, `#` comments
 * dropped, and a `;` closing each line that ends a statement. One output line
 * per input line.
 */
function powershellSqlLines(lines: string[]): string[] {
  const out: string[] = [];
  let here: string | null = null;
  const lit = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  for (const line of lines) {
    if (here) {
      if (line.startsWith(here)) { here = null; out.push(";"); continue; }
      out.push(lit(line));
      continue;
    }
    const open = /@(["'])\s*$/.exec(line);
    let code = "";
    let text = "";
    let quote: string | null = null;
    const body = open ? line.slice(0, open.index) : line;
    for (let i = 0; i < body.length; i++) {
      const c = body[i]!;
      if (quote) {
        if (c === "`" && quote === '"') { text += body[i + 1] ?? ""; i++; continue; }
        if (c === quote && body[i + 1] === quote) { text += c; i++; continue; }
        if (c === quote) { code += lit(text); text = ""; quote = null; continue; }
        text += c;
        continue;
      }
      if (c === "#") break;
      if (c === '"' || c === "'") { quote = c; continue; }
      code += c;
    }
    if (quote) code += lit(text);
    if (open) { here = open[1] + "@"; out.push(code); continue; }
    if (!/(?:`|[|,(+]|-and|-or)\s*$/i.test(code)) code += ";";
    out.push(code);
  }
  return out;
}
