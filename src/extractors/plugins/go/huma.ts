import type { RouteFact, RouteInfo } from "../../../types/analysis.js";

/**
 * Huma (github.com/danielgtaylor/huma) operations as routes.
 *
 *   huma.Register(api, huma.Operation{Method: http.MethodGet, Path: "/items/{id}"}, getItem)
 *   huma.Get(api, "/items/{id}", getItem)
 *   Register(api, huma.Operation{…}, h)        — a project wrapper taking the literal
 *
 * An operation's path is relative to the API it registers on, which is built
 * elsewhere — often on a router group (`humaecho.NewWithGroup(e, e.Group("/api/v2"), cfg)`).
 * Rows are emitted with `prefixUnresolved: "base:huma"`; the Go route resolver
 * (huma-resolver.ts) settles the base from the OpenAPI servers the project
 * declares (`huma.Server{URL: "/api/v2"}` — Huma's documented way to say where
 * an API is mounted) and synthesizes the PATCH `autopatch.AutoPatch` adds for
 * every path with a GET and a PUT. The facts it needs travel as route facts:
 * `huma-server` (the URL as resolved in this file, or the constant it names)
 * and `huma-autopatch`.
 */

export const HUMA_SERVER_FACT = "huma-server";
export const HUMA_AUTOPATCH_FACT = "huma-autopatch";
export const HUMA_OWNER = "huma";

export interface HumaServerFact {
  /** The server URL's path when this file can evaluate it, else null. */
  path: string | null;
  /** The constant the URL ends with (`GroupPrefix`), for files that cannot see its value. */
  name: string | null;
}

const VERB_FUNCS: Record<string, string> = { Get: "GET", Post: "POST", Put: "PUT", Patch: "PATCH", Delete: "DELETE", Head: "HEAD", Options: "OPTIONS" };
const METHOD_CONST: Record<string, string> = {
  MethodGet: "GET", MethodPost: "POST", MethodPut: "PUT", MethodPatch: "PATCH",
  MethodDelete: "DELETE", MethodHead: "HEAD", MethodOptions: "OPTIONS",
};

// `huma.Operation{` — the literal; the call it is the second argument of registers it,
// whatever that call is named (`huma.Register`, a wrapper `Register`, `registerGated`).
const OPERATION_RE = /&?huma\.Operation\s*\{/g;
// The call head just before it: `huma.Register[In, Out](api, ` / `registerGated(api, `,
// optionally through one helper that adjusts the operation (`Register(api, withUploadLimits(`).
const CALL_HEAD_RE = /([\w.]+)\s*(?:\[[^\]\n]*\])?\s*\(\s*[\w.]+\s*,\s*(?:[\w.]+\s*\(\s*)?$/;
const VERB_RE = /\bhuma\.(Get|Post|Put|Patch|Delete|Head|Options)\s*(?:\[[^\]\n]*\])?\s*\(/g;
const SERVER_RE = /huma\.Server\s*\{[^}]*?\bURL\s*:\s*([^,}\n]+)/g;

export function extractHumaRoutes(lines: string[], facts?: RouteFact[]): RouteInfo[] {
  const text = lines.join("\n");
  if (!text.includes("huma")) return [];
  const lineAt = lineIndex(text);
  const consts = stringConsts(text);
  const routes: RouteInfo[] = [];

  const push = (method: string, path: string, handler: string | null, offset: number): void => {
    routes.push({
      path,
      httpMethod: method,
      kind: "api",
      handler,
      calls: [],
      middleware: [],
      line: lineAt(offset),
      owner: HUMA_OWNER,
      prefixUnresolved: "base:huma",
    });
  };

  for (const m of text.matchAll(OPERATION_RE)) {
    const windowStart = Math.max(0, m.index! - 200);
    const head = CALL_HEAD_RE.exec(text.slice(windowStart, m.index!));
    if (!head) continue;
    const at = windowStart + head.index;
    const callStart = at + head[0].indexOf("(");
    const args = callArgs(text, callStart);
    if (!args || args.length < 3) continue;
    let op = args[1]!.replace(/^&/, "").trim();
    const wrapped = /^[\w.]+\s*\(\s*(&?huma\.Operation\s*\{[\s\S]*\})\s*\)$/.exec(op);
    if (wrapped) op = wrapped[1]!.replace(/^&/, "");
    if (!/^huma\.Operation\s*\{/.test(op)) continue;
    const method = fieldMethod(op);
    const path = pathValue(field(op, "Path"), consts);
    if (!method || !path?.startsWith("/")) continue;
    push(method, path, handlerOf(args[2]!, text, at), at);
  }
  for (const m of text.matchAll(VERB_RE)) {
    const args = callArgs(text, m.index! + m[0].length - 1);
    if (!args || args.length < 3) continue;
    const path = pathValue(args[1], consts);
    if (!path?.startsWith("/")) continue;
    push(VERB_FUNCS[m[1]!]!, path, handlerOf(args[2]!, text, m.index!), m.index!);
  }

  if (facts) {
    for (const m of text.matchAll(SERVER_RE)) facts.push({ kind: HUMA_SERVER_FACT, line: lineAt(m.index!), data: serverFact(m[1]!.trim(), consts) });
    const auto = /\bautopatch\.AutoPatch\s*\(/.exec(text);
    if (auto) facts.push({ kind: HUMA_AUTOPATCH_FACT, line: lineAt(auto.index), data: null });
  }
  return routes;
}

/** `GroupPrefix`, `"/api/v2"`, `publicURL + GroupPrefix` (a runtime host before a known path). */
function serverFact(expr: string, consts: Map<string, string>): HumaServerFact {
  const parts = expr.split("+").map((p) => p.trim());
  const last = parts[parts.length - 1]!;
  const name = /^[A-Za-z_]\w*$/.test(last) ? last : null;
  const values = parts.map((p) => stringValue(p, consts));
  // Every part known: the whole URL. Only a leading host unknown: the path after it.
  let url: string | null = values.every((v) => v !== null) ? values.join("") : null;
  if (url === null && values.length > 1 && values[0] === null && values.slice(1).every((v) => v !== null)) {
    url = values.slice(1).join("");
    if (!url.startsWith("/")) url = null;
  }
  const path = url === null ? null : url.replace(/^[a-z]+:\/\/[^/]+/i, "") || "/";
  return { path: path === null ? null : path.replace(/\/+$/, "") || "", name };
}

/**
 * A path, possibly concatenated: `"/migration/" + name + "/auth"` — a name no
 * constant gives stands for one segment (`/migration/{name}/auth`), the way a
 * route parameter does. Anything else (a call, an index) is not a path.
 */
function pathValue(expr: string | null | undefined, consts: Map<string, string>): string | null {
  if (!expr) return null;
  const parts = splitPlus(expr);
  if (parts.length === 0) return null;
  let out = "";
  for (const part of parts) {
    const v = stringValue(part, consts);
    if (v !== null) out += v;
    else if (/^[A-Za-z_]\w*$/.test(part) && /\/$/.test(out)) out += `{${part}}`;
    else return null;
  }
  return out;
}

/** `a + "b" + c` at the top level, strings kept whole. */
function splitPlus(expr: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!;
    if (ch === '"' || ch === "`") i = skipString(expr, i);
    else if (ch === "(" || ch === "[" || ch === "{") return [expr.trim()];
    else if (ch === "+") {
      out.push(expr.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(expr.slice(start).trim());
  return out.filter(Boolean);
}

function fieldMethod(op: string): string | null {
  const raw = field(op, "Method");
  if (!raw) return null;
  const c = /^http\.(Method\w+)$/.exec(raw);
  if (c) return METHOD_CONST[c[1]!] ?? null;
  const lit = /^"(\w+)"$/.exec(raw);
  return lit ? lit[1]!.toUpperCase() : null;
}

/** The value expression of `Name:` at the struct literal's top level. */
function field(literal: string, name: string): string | null {
  const body = literal.slice(literal.indexOf("{") + 1, literal.lastIndexOf("}"));
  for (const part of splitTop(body)) {
    const code = part.replace(/^(?:\s*\/\/[^\n]*\n)+/, "").trim();
    const m = new RegExp(`^${name}\\s*:\\s*([\\s\\S]+)$`).exec(code);
    if (m) return m[1]!.trim();
  }
  return null;
}

function stringValue(expr: string | null | undefined, consts: Map<string, string>): string | null {
  if (!expr) return null;
  const e = expr.trim();
  const lit = /^"((?:[^"\\]|\\.)*)"$/.exec(e) ?? /^`([^`]*)`$/.exec(e);
  if (lit) return lit[1]!;
  if (/^[A-Za-z_]\w*$/.test(e)) return consts.get(e) ?? null;
  return null;
}

/** The handler as written; an inline `func(…)` anchors on the function declaring it. */
function handlerOf(arg: string, text: string, offset: number): string | null {
  const a = arg.trim();
  if (/^[\w.]+$/.test(a)) return a;
  if (/^func\s*\(/.test(a)) {
    const before = text.slice(0, offset);
    const decls = [...before.matchAll(/^func\s+(?:\([^)]*\)\s*)?(\w+)\s*[[(]/gm)];
    return decls.length > 0 ? decls[decls.length - 1]![1]! : null;
  }
  return null;
}

/** `const X = "…"` and `X = "…"` inside a `const (…)` block. */
function stringConsts(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/^\s*(?:const\s+)?([A-Za-z_]\w*)\s*(?:string\s*)?=\s*"((?:[^"\\]|\\.)*)"\s*$/gm)) {
    if (!out.has(m[1]!)) out.set(m[1]!, m[2]!);
  }
  return out;
}

/** Top-level comma-separated arguments of the call whose `(` is at `open`, or null when unbalanced. */
function callArgs(text: string, open: number): string[] | null {
  const end = matching(text, open);
  return end < 0 ? null : splitTop(text.slice(open + 1, end));
}

function matching(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(text: string, start: number): number {
  const q = text[start]!;
  for (let i = start + 1; i < text.length; i++) {
    if (q !== "`" && text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === q) return i;
  }
  return text.length;
}

function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(body, i);
      continue;
    }
    if (ch === "/" && body[i + 1] === "/") {
      const nl = body.indexOf("\n", i);
      i = nl < 0 ? body.length : nl;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  const tail = body.slice(start);
  if (tail.trim()) out.push(tail);
  return out.map((s) => s.trim()).filter(Boolean);
}

function lineIndex(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}
