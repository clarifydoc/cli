import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";

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

export function extractVbDataSources(
  lines: string[],
  _classes: ClassInfo[],
): DataSourceInfo[] {
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
