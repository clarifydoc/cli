import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Detect API call sites in VB.NET / VBA source code.
 *
 * Patterns recognized:
 *   _api.GetAsync(Of User)("/api/users")
 *   _api.PostAsync(Of LoginResponse)("/api/auth/login", payload)
 *   _http.GetAsync("https://example.com/foo")
 *   Await client.PutAsync(Of T)($"/api/users/{id}", body)
 *
 * The `target` field is set to the literal URL path so that cross-repository
 * route linking can match it against `RouteInfo.path` in other files.
 */

const HTTP_VERBS = new Set([
  "GetAsync", "PostAsync", "PutAsync", "PatchAsync", "DeleteAsync",
  "Get", "Post", "Put", "Patch", "Delete",
  "SendAsync", "Send",
]);

/** Map HTTP verb method names to a canonical uppercase method (or null for unknown). */
function verbFromMethodName(method: string): string | null {
  const m = method.match(/^(Get|Post|Put|Patch|Delete|Head|Options)(?:Async)?$/i);
  return m ? m[1].toUpperCase() : null;
}

/** Normalize a VB path literal: strip interpolation syntax `$"..."` → `"..."` */
function normalizePath(raw: string): string {
  return raw
    .replace(/^\$\s*/, "")          // drop `$` before interpolated string
    .replace(/^["'`]|["'`]$/g, "")  // strip surrounding quotes
    .replace(/\{[^}]+\}/g, (m) => { // turn `{id}` into `{id}` (keep as-is, just verify syntax)
      return m;
    });
}

export function extractVbDataSources(lines: string[], classes: ClassInfo[]): DataSourceInfo[] {
  return [...extractVbHttpClientCalls(lines, classes), ...extractComHttpCalls(lines), ...extractSqlStringDataSources(vbSqlLines(lines))]
    .sort((a, b) => a.line - b.line);
}

/**
 * `http.Open "GET", "https://api.example.com/orders/" & id, False` — the COM
 * HTTP objects (MSXML2.XMLHTTP / ServerXMLHTTP, WinHttp.WinHttpRequest) that
 * VBScript, classic ASP and VB6 call. The verb literal in first position is
 * what tells it from `rs.Open "SELECT …"` and `conn.Open "Provider=…"`.
 */
function extractComHttpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const re = /\.Open\s*\(?\s*"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"\s*,\s*"([^"]+)"(?:\s*&\s*([A-Za-z_]\w*))?/i;
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(vbCodeLine(lines[i]!));
    if (!m) continue;
    const target = m[2]! + (m[3] ? `{${m[3]}}` : "");
    if (!target.startsWith("/") && !/^https?:/i.test(target)) continue;
    const method = m[1]!.toUpperCase();
    out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line: i + 1 });
  }
  return out;
}

/**
 * VB source in the C-like shape the shared SQL-string scanner reads: a
 * statement ends at the end of its line unless `_` (or a trailing operator)
 * carries it on, so the last physical line of each statement gets the `;` a
 * C statement would end with; `""` inside a string becomes `\"`; comments go.
 * One output line per input line, so line numbers stay true.
 */
function vbSqlLines(lines: string[]): string[] {
  const out = lines.map(vbCodeLine);
  for (let i = 0; i < out.length; i++) {
    if (!/(?:\s_|[,(&+])\s*$/.test(out[i]!)) out[i] += ";";
  }
  return out;
}

/** One VB line with its comment dropped and `""` escapes written `\"`. */
function vbCodeLine(line: string): string {
  if (/^\s*REM\b/i.test(line)) return "";
  if (!line.includes('"') && !line.includes("'")) return line;
  let out = "";
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inString) {
      if (c === '"' && line[i + 1] === '"') { out += '\\"'; i++; continue; }
      if (c === '"') inString = false;
      out += c;
      continue;
    }
    if (c === "'") break;
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/** VB.NET HttpClient-style calls with a literal route (see file header). */
function extractVbHttpClientCalls(lines: string[], _classes: ClassInfo[]): DataSourceInfo[] {
  const results: DataSourceInfo[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip VB comment lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith("'") || /^REM\b/i.test(trimmed)) continue;

    // Match: some.method[(Of T)]("path", ...)  OR  ("path")
    // Handle nested generics (Of List(Of User)) by consuming a balanced `(Of ...)` block.
    const callRe = /(\w+(?:\.\w+)?)(\s*\(Of\s+)?/g;
    let m: RegExpExecArray | null;
    while ((m = callRe.exec(line)) !== null) {
      const fullRef = m[1];
      const methodName = fullRef.includes(".") ? fullRef.split(".").pop()! : fullRef;
      if (!HTTP_VERBS.has(methodName)) continue;

      // Advance the cursor past the optional `(Of ...)` generic-arg block
      let idx = m.index + m[0].length;
      if (m[2]) {
        // Skip balanced parens to find matching `)`
        let depth = 1;
        while (idx < line.length && depth > 0) {
          const c = line[idx++];
          if (c === "(") depth++;
          else if (c === ")") depth--;
        }
      }

      // Now expect an opening paren + string literal
      const rest = line.slice(idx);
      const argMatch = rest.match(/^\s*\(\s*(\$?\s*"[^"]+"|\$?\s*'[^']+')/);
      if (!argMatch) continue;

      const rawPath = argMatch[1].trim();
      const path = normalizePath(rawPath);
      // Only track paths that look like URLs or routes
      if (!path.startsWith("/") && !path.startsWith("http")) continue;

      const httpMethod = verbFromMethodName(methodName);
      const key = `${i}::${fullRef}::${path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        kind: "api-call",
        name: httpMethod ? `${httpMethod} ${path}` : fullRef,
        target: path,
        calls: [],
        line: i + 1,
      });
    }
  }

  return results;
}
