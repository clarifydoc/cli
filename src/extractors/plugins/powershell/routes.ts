import type { RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, findEndLine, type CallPattern } from "../shared/regex-base.js";

/**
 * PowerShell web routes:
 *
 *  - Pode: `Add-PodeRoute -Method Get, Post -Path '/users/:id' -ScriptBlock { … }`
 *    (parameters in any order, spread over backtick-continued lines), inside
 *    `Add-PodeRouteGroup -Path '/api' -Routes { … }` prefixes;
 *    `-Authentication 'Login'` is the route's guard.
 *  - Polaris: `New-PolarisRoute -Method GET -Path "/x"`, `New-Polaris<Verb>Route -Path "/x"`.
 *
 * The handler is the route's own script block, so the calls made in it are
 * the route's `calls` (the linker follows them); a `-FilePath` handler script
 * is not read.
 */
export function extractPowerShellRoutes(lines: string[], callPatterns: CallPattern[]): RouteInfo[] {
  if (!lines.some((l) => /\b(?:Add-PodeRoute|New-Polaris\w*Route)\b/i.test(l))) return [];
  const routes: RouteInfo[] = [];
  const groups: Array<{ prefix: string; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    while (groups.length > 0 && i >= groups[groups.length - 1]!.end) groups.pop();
    const { text, last } = statement(lines, i);
    const group = /\bAdd-PodeRouteGroup\b/i.test(text) ? argString(text, "Path") : null;
    if (group !== null) {
      const open = blockStart(lines, i, last, "Routes");
      if (open !== null) groups.push({ prefix: group, end: findEndLine(lines, open, "brace") });
      continue;
    }
    const pode = /\bAdd-PodeRoute\b/i.test(text);
    const polaris = /\bNew-Polaris(Get|Post|Put|Delete|Patch)?Route\b/i.exec(text);
    if (!pode && !polaris) continue;
    const path = argString(text, "Path");
    if (path === null) continue;
    const methods = polaris?.[1] ? [polaris[1].toUpperCase()] : argList(text, "Method").map((m) => m.toUpperCase());
    const prefix = groups.map((g) => g.prefix).join("");
    const auth = argString(text, "Authentication");
    const open = blockStart(lines, i, last, "ScriptBlock");
    const end = open !== null ? findEndLine(lines, open, "brace") : last + 1;
    // The block's statements: the rest of the line after its `{`, then the
    // lines up to its `}` — never the `Add-PodeRoute …` line itself.
    let calls: RouteInfo["calls"] = [];
    if (open !== null) {
      const brace = lines[open]!.indexOf("{", lines[open]!.search(/-ScriptBlock\s*\{/i));
      calls = extractCallsFromBody(lines, open + 1, end, ["#"], callPatterns, { line: open, column: brace + 1 });
    }
    for (const method of methods.length > 0 ? methods : [null]) {
      routes.push({
        path: joinPath(prefix, path),
        httpMethod: method === "*" ? null : method,
        kind: "api",
        handler: null,
        calls,
        middleware: auth ? [`Authentication(${auth})`] : [],
        line: i + 1,
      });
    }
    i = Math.max(i, last);
  }
  return routes;
}

/** The statement starting on line `i`, backtick continuations joined; `last` is its final line index. */
function statement(lines: string[], i: number): { text: string; last: number } {
  let text = lines[i]!;
  let last = i;
  while (/`\s*$/.test(lines[last]!) && last + 1 < lines.length) {
    last++;
    text = text.replace(/`\s*$/, " ") + lines[last];
  }
  return { text, last };
}

/** `-Name 'value'` / `-Name "value"` / `-Name value`. */
function argString(text: string, name: string): string | null {
  const m = new RegExp(String.raw`-${name}\s+(?:(["'])([^"']*)\1|([^\s\`{]+))`, "i").exec(text);
  return m ? (m[2] ?? m[3] ?? null) : null;
}

/** `-Method Get, Post` / `-Method @('Get','Post')` / `-Method 'Get'`. */
function argList(text: string, name: string): string[] {
  const m = new RegExp(String.raw`-${name}\s+(@\([^)]*\)|[^-\`{]+?)(?=\s+-\w|\s*\`|\s*\{|\s*$)`, "i").exec(text);
  if (!m) return [];
  return [...m[1]!.matchAll(/[A-Za-z*]+/g)].map((x) => x[0]).filter((w) => w !== "@");
}

/** Line index of the `{` that opens `-<param> {`, searched from `from` through `last` (and the next line). */
function blockStart(lines: string[], from: number, last: number, param: string): number | null {
  const re = new RegExp(String.raw`-${param}\s*\{`, "i");
  for (let j = from; j <= Math.min(last + 1, lines.length - 1); j++) if (re.test(lines[j]!)) return j;
  return null;
}

function joinPath(prefix: string, path: string): string {
  const joined = (prefix.replace(/\/+$/, "") + "/" + path.replace(/^\/+/, "")).replace(/\/+$/, "");
  return joined === "" ? "/" : joined;
}
