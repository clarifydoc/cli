import type { ClassInfo, PathArgCall } from "../../../types/analysis.js";
import { closeOf, codeOf } from "./di.js";

/**
 * A project's own request wrapper, and the facts the core's request-factory
 * pass needs to follow it (`expandRequestFactories`):
 *
 *   class ApiConnection {
 *     Future<Response> request(RequestType requestType, String url, {Body? body}) async {
 *       var completeUrl = this.getBaseUrl() + url;
 *       if (requestType == RequestType.GET) response = await this.getDio().get(completeUrl);
 *       …
 *   }
 *   ApiConnection().request(RequestType.GET, '/${Settings.apiBasePath}/clubs/open');
 *
 * The wrapper's dio rows carry `${url}` (see `dartUrlArg`); each call site is
 * a `PathArgCall` with its literals, the class it is made on and the verb its
 * enum argument names; the `static const apiBasePath = "mobile"` it
 * interpolates is a `fieldValues` entry of `Settings`.
 */

/** A receiver name that looks like an HTTP client (`http`, `dio`, `_client`, `apiClient`, `getDio()`, `Dio()`). */
const HTTP_RECEIVER_RE = /(?:^|_)(?:http|dio|client|api)/i;

export function isDartHttpReceiver(receiver: string): boolean {
  return HTTP_RECEIVER_RE.test(receiver.replace(/\(\)$/, "").replace(/^_?get(?=[A-Z])/, ""));
}

const VERB_MEMBER_RE = /^[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|head|options)$/i;
const VERB_STRING_RE = /^(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1$/i;

/** The HTTP verb an argument names: `RequestType.POST`, `HttpMethod.delete`, `'GET'`. */
export function dartVerbArg(arg: string): string | null {
  const t = arg.trim();
  const m = VERB_MEMBER_RE.exec(t) ?? VERB_STRING_RE.exec(t);
  return m ? m[m.length - 1]!.toUpperCase() : null;
}

/** Split at depth-0 occurrences of `sep`, outside quotes and brackets. */
function splitOutside(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

const LITERAL_RE = /(r?)(['"])((?:\\.|(?!\2)[^\\])*)\2/y;

/**
 * The content of a part made only of string literals (adjacent ones, `'/a/'
 * '$b'`, are one string), its interpolations as `${…}` holes; null when the
 * part is anything else.
 */
function literalContent(part: string): string | null {
  const t = part.trim();
  let out = "";
  let any = false;
  for (let i = 0; i < t.length; ) {
    if (/\s/.test(t[i]!)) {
      i++;
      continue;
    }
    LITERAL_RE.lastIndex = i;
    const m = LITERAL_RE.exec(t);
    if (!m) return null;
    out += m[1] ? m[3]! : interpolated(m[3]!);
    i = LITERAL_RE.lastIndex;
    any = true;
  }
  return any ? out : null;
}

/** A string body with `$name` and `${expr}` as `${…}` holes and escapes resolved. */
function interpolated(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      out += body[++i] ?? "";
    } else if (c === "$" && body[i + 1] === "{") {
      let depth = 0;
      let end = i + 1;
      for (; end < body.length; end++) {
        if (body[end] === "{") depth++;
        else if (body[end] === "}" && --depth === 0) break;
      }
      out += `\${${body.slice(i + 2, end).trim()}}`;
      i = end;
    } else if (c === "$" && /[A-Za-z_]/.test(body[i + 1] ?? "")) {
      const name = /^[A-Za-z_]\w*/.exec(body.slice(i + 1))![0];
      out += `\${${name}}`;
      i += name.length;
    } else out += c;
  }
  return out;
}

/**
 * A URL expression in hole notation: string literals keep their text, with
 * interpolations as `${…}` holes, and every other operand of a `+` becomes a
 * hole of its own (`this.getBaseUrl() + url` → `${this.getBaseUrl()}${url}`).
 * Null when no part is a literal and the expression is not a plain operand.
 */
export function dartUrlExpr(expr: string): string | null {
  const parts = splitOutside(expr.trim(), "+").map((p) => p.trim());
  if (parts.some((p) => !p)) return null;
  let out = "";
  for (const p of parts) {
    const lit = literalContent(p);
    if (lit !== null) out += lit;
    else if (/^(?:this\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(p)) out += `\${${p}}`;
    else return null;
  }
  return out;
}

/**
 * The URL a client call's first argument names: a literal or `Uri.parse(…)` as
 * `dartUrlExpr` renders it; a variable as the value a local of that name was
 * given above the call in the same block (`var url = base + path;`), else as
 * a `${name}` hole — a wrapper's parameter, which each call site fills.
 */
export function dartUrlArg(lines: string[], row: number, fromIndex: number): string | null {
  let line = lines[row] ?? "";
  let rest = line.slice(fromIndex);
  // `dio.post(\n  '/clubs', …)`: the argument starts on the next line.
  if (!rest.trim() && row + 1 < lines.length) {
    line = lines[++row]!;
    rest = line;
  }
  const close = closeOf("(" + codeOf(rest), 0);
  const argText = close > 0 ? rest.slice(0, close - 2) : rest;
  let first = splitOutside(argText, ",")[0]?.trim() ?? "";
  const uri = /^Uri\.(?:parse|tryParse)\(([\s\S]*)\)$/.exec(first);
  if (uri) first = uri[1]!.trim();
  if (!first || /^[A-Za-z_$]\w*\s*:/.test(first)) return null;
  const ident = /^[A-Za-z_$]\w*$/.test(first) ? first : null;
  if (ident) {
    const decl = new RegExp(String.raw`^\s*(?:(?:final|var|late|const)\s+)*(?:String\??\s+)?${ident}\s*=(?!=)(.*)$`);
    // Upward through the enclosing blocks only: a `}` above starts a block
    // the call is not in, a `{` is one it is in.
    let depth = 0;
    for (let j = row - 1; j >= Math.max(0, row - 60); j--) {
      const code = codeOf(lines[j] ?? "");
      const opens = code.split("{").length - 1;
      const closes = code.split("}").length - 1;
      depth += closes - opens;
      const m = depth <= 0 ? decl.exec(code) : null;
      if (m) {
        const value = statementValue(lines, j, (lines[j] ?? "").slice(m.index + m[0].length - m[1]!.length));
        const url = value === null ? null : dartUrlExpr(value.replace(/^Uri\.(?:parse|tryParse)\(([\s\S]*)\)$/, "$1"));
        // `String url = '';` and the like is a placeholder some branch overwrites.
        return url ? url : `\${${ident}}`;
      }
      // The enclosing function's own `) {`: nothing above it is its local.
      if (opens > closes && /\)\s*(?:async\*?|sync\*?)?\s*\{\s*$/.test(code) && !/^\s*(?:\}|if|for|while|switch|catch|else)\b/.test(code)) break;
    }
    return `\${${ident}}`;
  }
  const rendered = dartUrlExpr(first);
  // A bare variable-less expression (`'$baseUrl/x'`) is a URL; `someCall()` alone is not.
  return rendered !== null && rendered !== `\${${first}}` ? rendered : null;
}

/** The rest of an assignment from `head` on line `j` up to its `;` (a few lines at most), comments dropped. */
function statementValue(lines: string[], j: number, head: string): string | null {
  let text = head;
  for (let k = j; k < Math.min(lines.length, j + 5); k++) {
    if (k > j) text += " " + (lines[k] ?? "");
    const code = codeOf(text);
    const semi = code.indexOf(";");
    if (semi >= 0) return text.slice(0, semi).trim();
  }
  return null;
}

/** `/x`, `api/x`, `${base}/x`, `/${Settings.apiBasePath}/x` — a path, not a word. */
const PATH_SHAPED = /^(?:\/[\w${-]|\$\{[^}]*\}\/|[.]?[\w-]+\/)/;

/** Callees handed a path that are not request wrappers: URI parsing, navigation, logging. */
const NOT_A_WRAPPER = new Set([
  "parse", "tryParse", "http", "https", "push", "pushNamed", "pushReplacementNamed", "popAndPushNamed",
  "go", "goNamed", "replace", "launch", "launchUrl", "print", "debugPrint", "log", "join", "Text", "Image",
]);

/** `X()` / `X(...)` / `X` (static) → `X`; a variable → the type the file declares it with. */
function receiverTypeOf(receiver: string, code: string): string | undefined {
  const ctor = /^(?:new\s+)?([A-Z]\w*)(?:\(\s*\))?$/.exec(receiver);
  if (ctor) return ctor[1];
  const name = /^_?[a-z]\w*$/.test(receiver) ? receiver : null;
  if (!name) return undefined;
  const typed = new RegExp(String.raw`\b([A-Z]\w*)(?:<[^<>;]*>)?\??\s+${name}\s*[;=,)]`).exec(code);
  if (typed) return typed[1];
  const built = new RegExp(String.raw`\b${name}\s*=\s*(?:await\s+)?(?:new\s+)?([A-Z]\w*)\s*(?:<[^<>;]*>)?\s*\(`).exec(code);
  return built?.[1];
}

const CALL_HEAD_RE = /(?<![\w$.])(?:((?:this\s*\.\s*)?(?:new\s+)?[A-Za-z_$][\w$]*(?:\(\s*\))?)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Calls handing a path to a function — a request wrapper's call sites
 * (`FileAnalysis.pathArgCalls`). A call is kept when an argument is
 * path-shaped, or when one names a verb and another is a string: the verb
 * says it is a request (`request(RequestType.GET, 'clubs')`). Calls that are
 * themselves client requests (`dio.get('/x')`) are the data-source
 * extractor's.
 */
export function extractDartPathArgCalls(lines: string[]): PathArgCall[] {
  const raw = lines.join("\n");
  if (!/['"][^'"\n]*\/|\.(?:GET|POST|PUT|PATCH|DELETE)\b/i.test(raw)) return [];
  const code = lines.map(codeOf).join("\n");
  const lineStarts: number[] = [0];
  for (let i = 0; i < raw.length; i++) if (raw[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const out: PathArgCall[] = [];
  for (const m of code.matchAll(CALL_HEAD_RE)) {
    const receiver = m[1]?.replace(/\s+/g, "").replace(/^this\./, "") ?? null;
    const callee = m[2]!;
    if (NOT_A_WRAPPER.has(callee) || /^[A-Z]/.test(callee) && !receiver) continue;
    const open = m.index! + m[0].length - 1;
    const close = closeOf(code, open);
    if (close < 0) continue;
    const argCode = code.slice(open + 1, close - 1);
    const argRaw = raw.slice(open + 1, close - 1);
    // Split the raw text where the code (strings blanked) has its commas.
    const pieces: string[] = [];
    let start = 0;
    for (const c of splitOutside(argCode, ",")) {
      pieces.push(argRaw.slice(start, start + c.length));
      start += c.length + 1;
    }
    const positional = pieces.map((p) => p.trim()).filter((p) => p && !/^[A-Za-z_$]\w*\s*:(?!:)/.test(p));
    let method: string | undefined;
    const args = positional.map((p) => {
      const verb = dartVerbArg(p);
      if (verb) {
        method ??= verb;
        return null;
      }
      return /['"]/.test(p) ? dartUrlExpr(p) : null;
    });
    const pathy = args.some((a) => a !== null && PATH_SHAPED.test(a));
    if (!pathy && !(method && args.some((a) => a !== null))) continue;
    // A client's own request (`dio.get('/x')`) is a data source already.
    if (receiver && isDartHttpReceiver(receiver) && !method) continue;
    const site: PathArgCall = { callee, args, line: lineOf(m.index!) };
    const type = receiver ? receiverTypeOf(receiver, code) : undefined;
    if (type) site.receiverType = type;
    if (method) site.method = method;
    out.push(site);
  }
  return out;
}

/**
 * String values a class gives its fields at its own body depth —
 * `static const apiBasePath = "mobile";`, `final String prefix = '/v2';` —
 * as `ClassInfo.fieldValues`, the way a project pass reads
 * `${Settings.apiBasePath}` in a URL. A value that is not all string literal
 * is left out.
 */
export function dartFieldValues(lines: string[], cls: ClassInfo): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let depth = 0;
  let opened = false;
  const last = Math.min(cls.endLine, lines.length);
  for (let j = cls.line - 1; j < last; j++) {
    const code = codeOf(lines[j]!);
    if (opened && depth === 1) {
      const m = /^\s*(?:static\s+)?(?:const|final)\s+(?:String\??\s+)?([A-Za-z_$]\w*)\s*=\s*(.+?);\s*(?:\/\/.*)?$/.exec(lines[j]!);
      if (m && /^\s*(?:static\s+)?(?:const|final)\b/.test(code)) {
        const parts = splitOutside(m[2]!, "+").map((p) => literalContent(p));
        if (parts.every((p) => p !== null)) out[m[1]!] = parts.join("");
      }
    }
    for (const c of code) {
      if (c === "{") {
        depth++;
        opened = true;
      } else if (c === "}") depth--;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
