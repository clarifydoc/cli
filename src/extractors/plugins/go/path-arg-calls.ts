import type { DataSourceInfo, PathArgCall } from "../../../types/analysis.js";
import { callArgs } from "./mq-destinations.js";
import { extractGoImports } from "./imports.js";

/**
 * Go request factories and the calls that name their endpoint.
 *
 *     func NewClientRequest(method, url string) *ClientRequest {
 *         return &ClientRequest{url: url, req: &http.Request{Method: method}}   ← a request of `${url}`
 *     }
 *     func NewInternalRequest(ctx context.Context, url, method string) *ClientRequest {
 *         return httplib.NewClientRequest(method, url)                          ← hands its parameters on
 *     }
 *     func Shutdown(ctx context.Context) {
 *         reqURL := setting.LocalURL + "api/internal/manager/shutdown"
 *         req := NewInternalRequest(ctx, reqURL, "POST")                        ← names the endpoint
 *     }
 *
 * The factory's own row carries `${url}` (`goRequestFactoryRows`); each call
 * handing a URL — a literal, a local built from literals and names, or the
 * caller's own URL-named parameter — is a `PathArgCall` the project pass
 * (`expandRequestFactories`) joins to the factory, level by level.
 */

interface GoFunction {
  name: string;
  /** A method (`func (r *T) Name(…)`): reached through its receiver, never by a bare call. */
  method: boolean;
  params: string[];
  start: number;
  end: number;
  /** Takes a `*testing.T`/`testing.TB`: a test helper, whose requests are a test's. */
  testHelper: boolean;
}

const FUNC_RE = /^func\s+(\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(([^)]*)\)/;
const URL_PARAM = /url|uri|path|endpoint|link/i;
const VERB_LITERAL = /^"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"$|^http\.Method(Get|Post|Put|Patch|Delete|Head|Options)$/;
const STRING_LIT = /^"((?:[^"\\]|\\.)*)"$|^`([^`]*)`$/;
const NAME = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/;
/** A path or URL: `/x`, `api/x`, `${base}/x`, `https://…`. */
const URLISH = /^(?:\/|\$\{|https?:\/\/|[\w.-]+\/)\S*$/;
const MIME = /^[a-z]+\/[a-z0-9.+-]+$/i;
/** Packages whose calls never take a project factory's endpoint. */
const STDLIB = new Set(["fmt", "strings", "strconv", "errors", "log", "slog", "url", "json", "time", "os", "filepath", "path", "context", "bytes", "io", "sort", "sync", "http", "regexp", "utf8", "unicode", "math", "reflect", "base64", "hex", "atomic", "runtime", "httptest", "assert", "require", "util"]);
const KEYWORDS = new Set(["if", "for", "switch", "func", "return", "go", "defer", "select", "case", "make", "new", "len", "cap", "append", "panic", "recover", "copy", "delete", "string", "int", "int64", "byte", "rune", "float64", "error", "bool", "any"]);

/** Net brace change on a line, ignoring braces in strings and comments. */
function braceDelta(line: string): number {
  const stripped = line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "").replace(/\/\/.*$/, "");
  let d = 0;
  for (const ch of stripped) d += ch === "{" ? 1 : ch === "}" ? -1 : 0;
  return d;
}

/** Top-level functions with their parameter names and line span (0-based, inclusive). */
export function goFunctions(lines: readonly string[]): GoFunction[] {
  const out: GoFunction[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = FUNC_RE.exec(lines[i]!);
    if (!m) continue;
    const params = m[3]!.split(",").map((p) => /^\s*([A-Za-z_]\w*)/.exec(p)?.[1]).filter((p): p is string => !!p && p !== "_");
    let depth = braceDelta(lines[i]!);
    let k = i;
    while (depth > 0 && k + 1 < lines.length) depth += braceDelta(lines[++k]!);
    out.push({ name: m[2]!, method: !!m[1], params, start: i, end: k, testHelper: /\btesting\.(?:T|TB|B)\b/.test(m[3]!) });
    i = k;
  }
  return out;
}

/** Split at top-level `+`, quotes and parentheses honoured. */
function plusTerms(expr: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\" && quote === '"') cur += expr[++i] ?? "";
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "+" && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * A URL expression as a string with `${…}` holes: literals as written, names
 * as holes, `fmt.Sprintf("a/%s/%d", x, f(y))` with each verb its argument (a
 * name as a hole, anything else `{}`). Null for anything else.
 */
function renderUrl(expr: string, locals: ReadonlyMap<string, string>): string | null {
  let out = "";
  for (const t of plusTerms(expr.trim())) {
    const lit = STRING_LIT.exec(t);
    if (lit) {
      out += lit[1] ?? lit[2] ?? "";
      continue;
    }
    const sprintf = /^fmt\.Sprintf\s*\(/.exec(t);
    if (sprintf) {
      const args = callArgs([t], 0, sprintf[0].length - 1);
      const format = STRING_LIT.exec(args[0] ?? "");
      if (!format) return null;
      let k = 1;
      out += (format[1] ?? format[2] ?? "").replace(/%[-+# 0-9.]*[sdvqtx]/g, () => {
        const a = args[k++]?.trim() ?? "";
        return /^[A-Za-z_]\w*$/.test(a) ? `\${${a}}` : "{}";
      });
      continue;
    }
    if (NAME.test(t)) {
      out += locals.get(t) ?? `\${${t}}`;
      continue;
    }
    return null;
  }
  return out;
}

export function extractGoPathArgCalls(lines: string[]): PathArgCall[] {
  const text = lines.join("\n");
  if (!/\(/.test(text)) return [];
  const packages = new Set(extractGoImports(lines).flatMap((i) => i.specifiers));
  const out: PathArgCall[] = [];
  const fns = goFunctions(lines);
  for (const fn of fns) {
    const params = new Set(fn.params);
    const locals = new Map<string, string>();
    for (let i = fn.start + 1; i <= fn.end; i++) {
      const line = lines[i]!.replace(/\/\/.*$/, "");
      // `reqURL := setting.LocalURL + "api/x"`: what a later call hands on.
      const assign = /^\s*(?:var\s+)?([A-Za-z_]\w*)\s*:?=\s*(.+?)\s*$/.exec(line);
      if (assign && !params.has(assign[1]!)) {
        const v = renderUrl(assign[2]!, locals);
        if (v !== null && v.includes("/")) locals.set(assign[1]!, v);
        else locals.delete(assign[1]!);
      }
      for (const m of line.matchAll(/(?<![\w.])(?:([A-Za-z_]\w*)\.)?([A-Za-z_]\w*)\s*\(/g)) {
        const receiver = m[1];
        const callee = m[2]!;
        if (KEYWORDS.has(callee) || (receiver && (STDLIB.has(receiver) || !packages.has(receiver)))) continue;
        const raw = callArgs(lines, i, m.index! + m[0].length - 1);
        if (raw.length === 0) continue;
        const args: Array<string | null> = [];
        const argNames: Array<string | null> = [];
        let method: string | undefined;
        let urlish = false;
        for (const a of raw) {
          const verb = VERB_LITERAL.exec(a);
          if (verb) method = (verb[1] ?? verb[2]!).toUpperCase();
          const bare = /^[A-Za-z_]\w*$/.test(a) ? a : null;
          const value = verb ? (verb[1] ?? verb[2]!.toUpperCase()) : bare && !locals.has(bare) ? null : renderUrl(a, locals);
          args.push(value);
          argNames.push(value === null && bare ? bare : null);
          if ((value !== null && URLISH.test(value) && !MIME.test(value) && value.replace(/\$\{[^}]*\}/g, "").includes("/")) || (value === null && bare && params.has(bare) && URL_PARAM.test(bare))) urlish = true;
        }
        if (!urlish) continue;
        out.push({
          callee,
          ...(receiver ? { receiver } : {}),
          args,
          ...(argNames.some((n) => n !== null) ? { argNames } : {}),
          ...(method ? { method } : {}),
          line: i + 1,
        });
      }
    }
  }
  return [...out, ...literalFactorySites(lines, fns, out)];
}

/**
 * Calls of a function of this file that builds a URL from a parameter
 * (`newInternalRequestAPIForHooks(ctx, hookName, …)` handing on
 * `fmt.Sprintf("api/internal/hook/%s", hookName)`), with a string literal in
 * that parameter's place (`"pre-receive"`): a site whose literal fills the
 * hole, though it is no path itself.
 */
function literalFactorySites(lines: string[], fns: readonly GoFunction[], sites: readonly PathArgCall[]): PathArgCall[] {
  const feeding = new Map<string, Set<number>>();
  for (const fn of fns) {
    if (fn.method) continue;
    for (const s of sites) {
      if (s.line - 1 < fn.start || s.line - 1 > fn.end) continue;
      for (const a of s.args) {
        for (const m of (a ?? "").matchAll(/\$\{([A-Za-z_]\w*)\}/g)) {
          const i = fn.params.indexOf(m[1]!);
          if (i >= 0) (feeding.get(fn.name) ?? feeding.set(fn.name, new Set()).get(fn.name)!).add(i);
        }
      }
    }
  }
  if (feeding.size === 0) return [];
  const seen = new Set(sites.map((s) => `${s.line}:${s.callee}`));
  const out: PathArgCall[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\/\/.*$/, "");
    for (const m of line.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\(/g)) {
      const at = feeding.get(m[1]!);
      if (!at || seen.has(`${i + 1}:${m[1]}`) || /^\s*func\b/.test(line)) continue;
      const raw = callArgs(lines, i, m.index! + m[0].length - 1);
      const args = raw.map((a) => {
        const lit = STRING_LIT.exec(a.trim());
        return lit ? lit[1] ?? lit[2] ?? "" : null;
      });
      if (![...at].some((k) => args[k] !== null && args[k] !== undefined)) continue;
      out.push({ callee: m[1]!, args, line: i + 1 });
    }
  }
  return out;
}

/**
 * The request a factory builds from its parameters: `http.NewRequest(method, url, …)`
 * with the URL a parameter, or an `http.Request{Method: method}` in a function
 * taking a URL-named parameter — an api-call of `${url}`, whose verb each call
 * site names.
 */
export function goRequestFactoryRows(lines: string[]): DataSourceInfo[] {
  if (!/http\.(?:NewRequest|Request\s*\{)/.test(lines.join("\n"))) return [];
  const out: DataSourceInfo[] = [];
  for (const fn of goFunctions(lines)) {
    if (fn.testHelper) continue;
    const params = new Set(fn.params);
    for (let i = fn.start; i <= fn.end; i++) {
      const line = lines[i]!;
      const req = /http\.NewRequest(?:WithContext)?\s*\(/.exec(line);
      if (req) {
        const args = callArgs(lines, i, req.index + req[0].length - 1);
        const [m, u] = /WithContext/.test(req[0]) ? args.slice(1) : args;
        if (m && u && params.has(u) && !VERB_LITERAL.test(m)) out.push({ kind: "api-call", name: "http.NewRequest", target: `\${${u}}`, calls: [], line: i + 1 });
        continue;
      }
      const built = /http\.Request\s*\{[^}]*\bMethod\s*:\s*([A-Za-z_]\w*)/.exec(line);
      const url = fn.params.find((p) => URL_PARAM.test(p));
      if (built && params.has(built[1]!) && url) out.push({ kind: "api-call", name: "http.Request", target: `\${${url}}`, calls: [], line: i + 1 });
    }
  }
  return out;
}
