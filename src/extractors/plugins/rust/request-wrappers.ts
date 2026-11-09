import type { DataSourceInfo, PathArgCall } from "../../../types/analysis.js";
import { blankCode } from "../shared/brace-code.js";
import { RUST_LEXICON } from "./lexicon.js";
import { parseRustParam } from "./params.js";

/**
 * A project's own request wrapper, and the facts the core's request-factory
 * pass needs to follow it (`expandRequestFactories`):
 *
 *     impl Api {
 *         pub fn post(&self, path: &str) -> RequestBuilder { self.request(Method::POST, path) }
 *         fn request(&self, method: Method, path: &str) -> RequestBuilder {
 *             self.http.client.request(method, api_url(&self.origin, path))      ← a request of `${self.origin}${path}`
 *         }
 *     }
 *     session.api.post("/clubs/contract/renew").send().await?;                   ← names the endpoint
 *     club_request(session, "/players/transfer", Method::POST).await             ← names it and its verb
 *
 * The client call inside the wrapper is an api-call row whose URL holds the
 * wrapper's path parameter (`rustClientRequests`, and the reqwest verbs of
 * data-sources.ts); each call handing a path — a literal, a `format!`, or the
 * caller's own path parameter — is a `PathArgCall` with the type it is called
 * on: `self` is the `impl`'s type, a parameter its declared type, and the
 * fields walked from there (`session.api` → `["api"]`) are `receiverFields`,
 * which core types field by field.
 */

interface RustFn {
  /** Offsets of the body's braces in the text. */
  from: number;
  to: number;
  /** Parameter name → declared type, as written. */
  params: Map<string, string>;
}

interface ImplSpan {
  from: number;
  to: number;
  type: string;
}

/** A file read once for the wrapper passes: its text, the same text with comments and literals blanked, functions and `impl` blocks. */
export interface RustCode {
  text: string;
  code: string;
  lineStarts: number[];
  fns: RustFn[];
  impls: ImplSpan[];
}

const FN_RE = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^{};()]*>)?\s*\(/g;
const IMPL_RE = /\bimpl\b\s*(?:<[^{};]*?>)?\s*([^{};]+?)\s*(?:where\b[^{]*)?\{/g;
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** A path or URL: `/x`, `api/x`, `${base}/x`, `https://…`. */
const URLISH = /^(?:\/|\$\{|https?:\/\/|[\w.-]+\/)\S*$/;
const URL_PARAM = /url|uri|path|endpoint|link/i;
const KEYWORDS = new Set(["if", "while", "for", "match", "return", "loop", "in", "as", "let", "fn", "move", "async", "await", "unsafe", "where", "impl", "dyn", "mut", "ref", "else", "Some", "Ok", "Err", "None"]);
/** Pointer types whose method calls reach their pointee (`Arc<Api>` calls `Api`'s methods). */
const WRAPPERS = new Set(["Arc", "Box", "Rc", "Cow"]);

/** The index of the bracket closing the one at `open` in blanked code, or -1. */
function closeOf(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `[from, to)` of each argument between the brackets at `open` and `close`, split at top-level commas (`<>` too when `angles`). */
function argSpans(code: string, open: number, close: number, angles = false, text = code): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{" || (angles && c === "<")) depth++;
    else if (c === ")" || c === "]" || c === "}" || (angles && c === ">" && code[i - 1] !== "-")) depth--;
    else if (c === "," && depth === 0) {
      out.push([start, i]);
      start = i + 1;
    }
  }
  // A blanked literal is an argument too: the text decides.
  if (text.slice(start, close).trim()) out.push([start, close]);
  return out;
}

/** `&'a mut league_core::Session` → `Session`; `Arc<Api>` → `Api`. */
export function rustTypeName(written: string): string | null {
  let t = written.trim().replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, "").replace(/^(?:mut|dyn|impl)\s+/, "").trim();
  for (let guard = 0; guard < 3; guard++) {
    const m = /^((?:\w+::)*)(\w+)\s*<(.*)>$/s.exec(t);
    if (!m || !WRAPPERS.has(m[2]!)) break;
    t = m[3]!.trim().replace(/^(?:dyn|impl)\s+/, "");
  }
  const name = /^(?:\w+::)*([A-Z]\w*)\s*(?:<.*)?$/s.exec(t)?.[1];
  return name ?? null;
}

export function readRustCode(lines: readonly string[]): RustCode {
  const text = lines.join("\n");
  const code = blankCode(text, RUST_LEXICON);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const fns: RustFn[] = [];
  for (const m of code.matchAll(FN_RE)) {
    const open = m.index + m[0].length - 1;
    const close = closeOf(code, open);
    if (close < 0) continue;
    const params = new Map<string, string>();
    for (const [a, b] of argSpans(code, open, close, true, text)) {
      const p = parseRustParam(text.slice(a, b));
      // The type as written: `parseRustParam` keeps only the bare identifier.
      const written = text.slice(a, b).slice(text.slice(a, b).search(/(?<!:):(?!:)/) + 1).trim();
      if (p) params.set(p.name, written);
    }
    // The body: the first `{` after the signature, unless a `;` ends a declaration first.
    let i = close + 1;
    while (i < code.length && code[i] !== "{" && code[i] !== ";") i++;
    if (code[i] !== "{") continue;
    const end = closeOf(code, i);
    if (end > 0) fns.push({ from: i, to: end, params });
  }
  const impls: ImplSpan[] = [];
  for (const m of code.matchAll(IMPL_RE)) {
    const head = m[1]!.trim();
    const target = / for\s+(.+)$/s.exec(head)?.[1] ?? head;
    const type = rustTypeName(target);
    const open = m.index + m[0].length - 1;
    const end = closeOf(code, open);
    if (type && end > 0) impls.push({ from: open, to: end, type });
  }
  return { text, code, lineStarts, fns, impls };
}

export function lineAt(rc: RustCode, offset: number): number {
  let lo = 0;
  let hi = rc.lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (rc.lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The innermost function whose body holds `offset`. */
export function fnAt(rc: RustCode, offset: number): RustFn | undefined {
  let best: RustFn | undefined;
  for (const f of rc.fns) if (f.from < offset && offset < f.to && (!best || f.from > best.from)) best = f;
  return best;
}

function implAt(rc: RustCode, offset: number): ImplSpan | undefined {
  let best: ImplSpan | undefined;
  for (const s of rc.impls) if (s.from < offset && offset < s.to && (!best || s.from > best.from)) best = s;
  return best;
}

/** A string literal's content (`"/x"`, `"/x".to_string()`), else null. */
function stringLiteral(arg: string): string | null {
  const m = /^&?\s*"((?:[^"\\]|\\.)*)"(?:\s*\.\s*(?:to_string|to_owned|into)\s*\(\s*\))?$/s.exec(arg.trim());
  return m ? m[1]!.replace(/\\(.)/g, "$1") : null;
}

/**
 * `format!("/clubs/{club_id}/players/{}", id)` with each placeholder its argument: a name inside the braces or a
 * bare name argument as a `${…}` hole, anything else `{}`. Null for anything but a `format!` with a literal template.
 */
function formatTemplate(arg: string): string | null {
  const m = /^&?\s*format!\s*\(\s*"((?:[^"\\]|\\.)*)"\s*(?:,(.*))?\)(?:\s*\.\s*(?:as_str|to_string)\s*\(\s*\))?$/s.exec(arg.trim());
  if (!m) return null;
  const rest = m[2] ?? "";
  const args: string[] = [];
  if (rest.trim()) {
    const wrapped = `(${rest})`;
    for (const [a, b] of argSpans(blankCode(wrapped, RUST_LEXICON), 0, wrapped.length - 1, false, wrapped)) args.push(wrapped.slice(a, b).trim());
  }
  let n = 0;
  return m[1]!
    .replace(/\{\{|\}\}|\{([^{}]*)\}/g, (whole, inner: string | undefined) => {
      if (whole === "{{") return "{";
      if (whole === "}}") return "}";
      const name = (inner ?? "").split(":")[0]!.trim();
      if (/^[A-Za-z_]\w*$/.test(name)) return `\${${name}}`;
      const value = /^\d+$/.test(name) ? args[Number(name)] : args[n++];
      const literal = value !== undefined ? stringLiteral(value) : null;
      if (literal !== null) return literal;
      const bare = value?.replace(/^&/, "").trim();
      return bare && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(bare) ? `\${${bare}}` : "{}";
    })
    .replace(/\\(.)/g, "$1");
}

/** `name`, `&name`, `name.as_str()`, `&name.clone()` → `name`; else null. */
function bareName(arg: string): string | null {
  const m = /^&?\s*([a-z_]\w*)(?:\s*\.\s*(?:as_str|as_ref|clone|to_string|to_owned)\s*\(\s*\))?$/.exec(arg.trim());
  return m ? m[1]! : null;
}

/** The verb an argument names: `Method::POST`, `reqwest::Method::DELETE`. */
function verbArg(arg: string): string | null {
  const m = /^(?:\w+::)*Method::([A-Z]+)$/.exec(arg.trim());
  return m && VERBS.has(m[1]!) ? m[1]! : null;
}

/**
 * The URL an argument of a client call requests, with `${…}` holes: a literal, a `format!`, a parameter of
 * the enclosing function (`${path}`), or a call handing that parameter last after a base
 * (`api_url(&self.origin, path)` → `${self.origin}${path}`). `local` reads a `let` the name binds.
 */
export function rustUrlArg(arg: string, params: ReadonlyMap<string, string> | undefined, local?: (name: string) => string | null): string | null {
  const lit = stringLiteral(arg) ?? formatTemplate(arg);
  if (lit !== null) return lit;
  const name = bareName(arg);
  if (name) return local?.(name) ?? (params?.has(name) ? `\${${name}}` : null);
  const call = /^&?\s*((?:[\w]+::)*[a-z_]\w*|self\.[a-z_]\w*)\s*\((.*)\)$/s.exec(arg.trim());
  if (!call || !params) return null;
  const wrapped = `(${call[2]})`;
  const parts = argSpans(blankCode(wrapped, RUST_LEXICON), 0, wrapped.length - 1, false, wrapped).map(([a, b]) => wrapped.slice(a, b).trim());
  const last = parts.length > 0 ? bareName(parts.at(-1)!) : null;
  if (!last || !params.has(last)) return null;
  const base = parts.length === 2 ? /^&?\s*((?:self\.)?[a-z_]\w*(?:\.[a-z_]\w*)*)$/.exec(parts[0]!)?.[1] : undefined;
  return base ? `\${${base}}\${${last}}` : `\${${last}}`;
}

const CLIENT_REQUEST_RE = /\.\s*request\s*\(/g;

/**
 * `client.request(method, url)` on a reqwest-style client (a receiver named `…client`, `reqwest::Client::new()`):
 * an api-call of the verb the first argument names, or of the verb a caller hands in (`name: "request"`).
 */
export function rustClientRequests(rc: RustCode): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (const m of rc.code.matchAll(CLIENT_REQUEST_RE)) {
    const before = rc.code.slice(Math.max(0, m.index - 200), m.index).replace(/\s+$/, "");
    // The receiver: a name ending in `client`, or `Client::new()` / `client()`.
    if (!/(?:\b\w*client|Client::new\s*\(\s*\)|\bclient\s*\(\s*\))$/i.test(before)) continue;
    const open = m.index + m[0].length - 1;
    const close = closeOf(rc.code, open);
    if (close < 0) continue;
    const args = argSpans(rc.code, open, close, false, rc.text).map(([a, b]) => rc.text.slice(a, b).trim());
    if (args.length !== 2) continue;
    const verb = verbArg(args[0]!);
    const param = bareName(args[0]!);
    const fn = fnAt(rc, m.index);
    // The verb is a literal one, or a parameter of the wrapper its callers name.
    if (!verb && !(param && fn?.params.has(param))) continue;
    out.push({ kind: "api-call", name: verb ?? "request", target: rustUrlArg(args[1]!, fn?.params), calls: [], line: lineAt(rc, m.index + m[0].length - 1) });
  }
  return out;
}

const CHAIN_CALL_RE = /(?<![\w.:)\]>])(self|[a-z_]\w*)((?:\s*\.\s*[a-z_]\w*(?:\s*\(\s*\))?)*)\s*\.\s*([a-z_]\w*)\s*\(/g;
const BARE_CALL_RE = /(?<![\w.:!])([a-z_]\w*)\s*\(/g;

export function extractRustPathArgCalls(lines: string[]): PathArgCall[] {
  const joined = lines.join("\n");
  if (!/["(]\s*\/|path|url|uri/i.test(joined)) return [];
  return rustPathArgCalls(readRustCode(lines));
}

export function rustPathArgCalls(rc: RustCode): PathArgCall[] {
  const out: PathArgCall[] = [];
  const site = (at: number, callee: string, open: number, receiver?: { type: string; fields: string[] }): void => {
    const close = closeOf(rc.code, open);
    if (close < 0) return;
    const fn = fnAt(rc, at);
    if (!fn) return;
    const args = argSpans(rc.code, open, close, false, rc.text).map(([a, b]) => rc.text.slice(a, b).trim());
    if (args.length === 0) return;
    const values = args.map((a) => stringLiteral(a) ?? formatTemplate(a));
    const names = args.map((a) => {
      const n = bareName(a);
      return n && fn.params.has(n) && URL_PARAM.test(n) ? n : null;
    });
    if (!values.some((v) => v !== null && URLISH.test(v)) && !names.some((n) => n !== null)) return;
    const method = args.map(verbArg).find((v) => v !== null);
    out.push({
      callee,
      args: values.map((v) => (v !== null && URLISH.test(v) ? v : null)),
      ...(names.some((n) => n !== null) ? { argNames: names } : {}),
      line: lineAt(rc, at),
      ...(receiver ? { receiverType: receiver.type, ...(receiver.fields.length ? { receiverFields: receiver.fields } : {}) } : {}),
      ...(method ? { method } : {}),
    });
  };
  // One-line literals kept, so `get("/clubs")` never reads as a getter `get()` of the chain.
  const chains = blankCode(rc.text, RUST_LEXICON, true);
  for (const m of chains.matchAll(CHAIN_CALL_RE)) {
    if (rc.code[m.index] !== rc.text[m.index]) continue; // inside a literal
    const head = m[1]!;
    // A field (`api`) or a getter called without arguments (`api()`).
    const fields = m[2] ? m[2].split(".").map((s) => s.replace(/\s+/g, "")).filter(Boolean) : [];
    const calleeAt = m.index + m[0].lastIndexOf(m[3]!);
    let type: string | null = null;
    if (head === "self") type = implAt(rc, m.index)?.type ?? null;
    else {
      const written = fnAt(rc, m.index)?.params.get(head);
      type = written ? rustTypeName(written) : null;
    }
    // A local or a module's value states no type to start from.
    if (!type) continue;
    site(calleeAt, m[3]!, m.index + m[0].length - 1, { type, fields });
  }
  for (const m of rc.code.matchAll(BARE_CALL_RE)) {
    const name = m[1]!;
    if (KEYWORDS.has(name) || /\bfn\s+$/.test(rc.code.slice(Math.max(0, m.index - 8), m.index))) continue;
    site(m.index, name, m.index + m[0].length - 1);
  }
  return out.sort((a, b) => a.line - b.line);
}
