import type { Node } from "web-tree-sitter";
import type { RouteInfo } from "../../../../types/analysis.js";
import { stripQuotes } from "../../../shared/node-helpers.js";
import { collectCallNames, HTTP_METHODS } from "../../../routes/base.js";
import { isRoutePath } from "./express.js";

/**
 * A raw Node server dispatching by hand: inside the request listener of `http.createServer(…)`
 * (or `https.` / a bare `createServer`), an `if` whose condition compares the request path with a
 * literal — `pathname === "/clubs"`, `req.url == "/health"` — serves that path, at the method a
 * `req.method === "POST"` in the same condition names (any method otherwise); a `switch (pathname)`
 * serves each literal `case`. The path is `req.url`, or a value whose name says it is one
 * (`pathname`, `url`, `route`; a bare `path` is usually `node:path`). The branch's calls are the route's.
 *
 * A route module a server file hands the request to (no `createServer` in it) is read from its own
 * comparisons, and a row there needs the method AND the path: `||` of methods counts only when every
 * side is a method, an enclosing method `if` covers the nested path `if`s (its `else` does not),
 * `!(…)` flips by parity, `!==` and `startsWith` say nothing, an anchored regex of single-segment
 * groups (`pathname.match(/^\/clubs\/([^/]+)$/)`) is `/clubs/{param}`, a constant of the file folds
 * in, and a bare `/` is never a route. A data table (`{ path, method, handler }` entries) is read
 * only when a `for…of` / `.find` over it compares both fields and the file calls `.handler(…)`.
 */

const VERB_COMPARE = /\.method\s*[=!]==?\s*["'`][A-Za-z]+["'`]|["'`][A-Za-z]+["'`]\s*[=!]==?\s*\w+\.method\b/;
const PATH_COMPARE = /\b(?:pathname|url|route|urlPath|reqPath|requestPath)\b\s*[=!]==?\s*(?:["'`]\/|`|[A-Z_][A-Z0-9_]*\b)|\.(?:match|test|exec)\(|["'`]\/[^"'`]*["'`]\s*[=!]==?\s*\w/;

/**
 * A file that may dispatch by hand: a `createServer(` call, or — a route module a server file hands
 * the request to — a request-method comparison together with a path comparison, or a route table's
 * entry fields read back (`route.method`, `route.path`, `route.handler(…)`).
 */
export function mayDispatchByHand(sourceText: string): boolean {
  if (sourceText.includes("createServer(")) return true;
  if (VERB_COMPARE.test(sourceText) && PATH_COMPARE.test(sourceText)) return true;
  return sourceText.includes(".handler(") && /\.method\b/.test(sourceText) && /\.path\b/.test(sourceText);
}

const FUNCTION_TYPES: ReadonlySet<string> = new Set(["arrow_function", "function_expression", "function", "function_declaration", "method_definition"]);
// A bare `path` is left out: it is usually `node:path`.
const PATH_NAME = /^(?:pathname|url|route|urlPath|reqPath|requestPath)$/;

/** The request listener `createServer` is handed: inline, or a function this file declares. */
function listenerOf(call: Node, root: Node): Node | null {
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  // `createServer(options, listener)`: the listener comes last.
  const fn = args.find((a) => FUNCTION_TYPES.has(a.type)) ?? [...args].reverse().find((a) => a.type === "identifier");
  if (!fn) return null;
  if (FUNCTION_TYPES.has(fn.type)) return fn;
  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.namedChildren[0] : stmt;
    if (decl?.type === "function_declaration" && decl.childForFieldName("name")?.text === fn.text) return decl;
    if (decl?.type === "lexical_declaration" || decl?.type === "variable_declaration") {
      for (const d of decl.namedChildren) {
        const value = d.childForFieldName("value");
        if (d.childForFieldName("name")?.text === fn.text && value && FUNCTION_TYPES.has(value.type)) return value;
      }
    }
  }
  return null;
}

function firstParamName(fn: Node): string | null {
  const params = fn.childForFieldName("parameters");
  const first = params ? params.namedChildren[0] : fn.childForFieldName("parameter");
  const ident = first?.type === "identifier" ? first : first?.childForFieldName("pattern");
  return ident?.type === "identifier" ? ident.text : null;
}

/** Is `node` the request's path: `req.url`, or a value named like one? */
function isPathExpr(node: Node, req: string): boolean {
  if (node.type === "identifier") return PATH_NAME.test(node.text);
  if (node.type === "member_expression") {
    const object = node.childForFieldName("object")?.text;
    const prop = node.childForFieldName("property")?.text ?? "";
    return (object === req && prop === "url") || prop === "pathname";
  }
  return false;
}

function isMethodExpr(node: Node, req: string): boolean {
  return node.type === "member_expression" && node.childForFieldName("object")?.text === req && node.childForFieldName("property")?.text === "method";
}

/** What a condition states about the request: the methods it admits and the path it serves. */
interface Facts {
  /** `null`: no method stated; `[]`: a contradiction or an unknown verb — no row. */
  verbs: string[] | null;
  path: string | null;
}
const NONE: Facts = { verbs: null, path: null };

interface Scope {
  req: string;
  consts: ReadonlyMap<string, string>;
}

function unwrap(node: Node): Node {
  let n = node;
  while (n.type === "parenthesized_expression" && n.namedChildren[0]) n = n.namedChildren[0];
  return n;
}

/** A string the file states: a literal, a template whose holes are file constants, a `+` of those, or a constant. */
function resolveString(node: Node, consts: ReadonlyMap<string, string>): string | null {
  const n = unwrap(node);
  if (n.type === "string") return stripQuotes(n.text);
  if (n.type === "identifier") return consts.get(n.text) ?? null;
  if (n.type === "template_string") {
    let out = "";
    for (const part of n.namedChildren) {
      if (part.type === "template_substitution") {
        const inner = part.namedChildren[0];
        const v = inner ? resolveString(inner, consts) : null;
        if (v === null) return null;
        out += v;
      } else if (part.type === "string_fragment") out += part.text;
      else if (part.type !== "comment") return null;
    }
    return out;
  }
  if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "+") {
    const l = n.childForFieldName("left");
    const r = n.childForFieldName("right");
    const a = l ? resolveString(l, consts) : null;
    const b = r ? resolveString(r, consts) : null;
    return a !== null && b !== null ? a + b : null;
  }
  return null;
}

/** String constants of the file; a name declared more than once (anywhere) is dropped. */
function fileConstants(root: Node): Map<string, string> {
  const seen = new Map<string, number>();
  const declared: Array<[string, Node]> = [];
  const visit = (node: Node): void => {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      if (name?.type === "identifier") {
        seen.set(name.text, (seen.get(name.text) ?? 0) + 1);
        const value = node.childForFieldName("value");
        if (value) declared.push([name.text, value]);
      }
    }
    for (const c of node.namedChildren) visit(c);
  };
  visit(root);
  const consts = new Map<string, string>();
  for (const [name, value] of declared) {
    if (seen.get(name) !== 1) continue;
    const v = resolveString(value, consts);
    if (v !== null) consts.set(name, v);
  }
  return consts;
}

const SEGMENT_GROUP = /^\((?:\?:)?(?:\[\^\\?\/\]|\\[dw]|\[(?!\^)[^\]/.]*\])[+*]?\)/;

/** An anchored regex whose groups each match one segment, as a path: `^\/clubs\/([^/]+)$` → `/clubs/{param}`. */
function regexPath(pattern: string): string | null {
  if (!pattern.startsWith("^\\/") && !pattern.startsWith("^/")) return null;
  const inner = pattern.slice(1);
  const body = inner.replace(/\\?\/\?\$$/, "").replace(/\$$/, "");
  if (body === inner) return null; // not anchored at the end
  let out = "";
  for (let i = 0; i < body.length; ) {
    const rest = body.slice(i);
    if (rest.startsWith("(")) {
      const m = SEGMENT_GROUP.exec(rest);
      if (!m) return null;
      out += "{param}";
      i += m[0].length;
    } else if (rest.startsWith("\\/")) {
      out += "/";
      i += 2;
    } else if (rest.startsWith("\\.")) {
      out += ".";
      i += 2;
    } else if (/^[A-Za-z0-9_\-/]/.test(rest)) {
      out += rest[0];
      i++;
    } else return null;
  }
  return out.startsWith("/") && out !== "/" ? out : null;
}

function regexOf(node: Node): string | null {
  const n = unwrap(node);
  return n.type === "regex" ? (n.childForFieldName("pattern")?.text ?? null) : null;
}

/** `pathname.match(/re/)`, `/re/.test(pathname)`, `/re/.exec(pathname)`. */
function pathOfRegexCall(call: Node, sc: Scope): string | null {
  const callee = call.childForFieldName("function");
  const arg = call.childForFieldName("arguments")?.namedChildren[0];
  if (callee?.type !== "member_expression" || !arg) return null;
  const object = callee.childForFieldName("object");
  const prop = callee.childForFieldName("property")?.text;
  if (!object) return null;
  if (prop === "match" && isPathExpr(unwrap(object), sc.req)) {
    const re = regexOf(arg);
    return re === null ? null : regexPath(re);
  }
  if ((prop === "test" || prop === "exec") && isPathExpr(unwrap(arg), sc.req)) {
    const re = regexOf(object);
    return re === null ? null : regexPath(re);
  }
  return null;
}

function intersect(a: string[], b: string[]): string[] {
  return a.filter((v) => b.includes(v));
}

/**
 * What a condition says, read by parity: `&&` joins, `||` counts only when every side names a method
 * (all or nothing), `!(…)` flips what an equality means, and a `!==` outside such a wrapper says nothing.
 */
function factsOf(node: Node, sc: Scope, odd: boolean): Facts {
  const n = unwrap(node);
  if (n.type === "unary_expression") {
    const arg = n.childForFieldName("argument");
    return n.childForFieldName("operator")?.text === "!" && arg ? factsOf(arg, sc, !odd) : NONE;
  }
  if (n.type === "call_expression") {
    if (odd) return NONE;
    const path = pathOfRegexCall(n, sc);
    return path === null ? NONE : { verbs: null, path };
  }
  if (n.type !== "binary_expression") return NONE;
  const op = n.childForFieldName("operator")?.text;
  const left = n.childForFieldName("left");
  const right = n.childForFieldName("right");
  if (!left || !right) return NONE;
  if (op === "&&" || op === "||") {
    if (odd) return NONE;
    const a = factsOf(left, sc, false);
    const b = factsOf(right, sc, false);
    if (op === "&&") {
      if (a.path !== null && b.path !== null && a.path !== b.path) return { verbs: [], path: null };
      const verbs = a.verbs === null ? b.verbs : b.verbs === null ? a.verbs : intersect(a.verbs, b.verbs);
      return { verbs, path: a.path ?? b.path };
    }
    const verbOnly = (f: Facts) => f.path === null && f.verbs !== null;
    return verbOnly(a) && verbOnly(b) ? { verbs: [...new Set([...a.verbs!, ...b.verbs!])], path: null } : NONE;
  }
  const positive = op === "===" || op === "==";
  if (!positive && op !== "!==" && op !== "!=") return NONE;
  if (positive === odd) return NONE; // an inequality, or an equality under `!`
  for (const [x, y] of [[left, right], [right, left]] as const) {
    const value = resolveString(y, sc.consts);
    if (value === null) continue;
    if (isMethodExpr(unwrap(x), sc.req)) return { verbs: HTTP_METHODS.has(value.toLowerCase()) ? [value.toUpperCase()] : [], path: null };
    if (isPathExpr(unwrap(x), sc.req)) return { verbs: null, path: value };
  }
  return NONE;
}

function route(path: string, method: string | null, body: Node | null, line: number): RouteInfo {
  return { path, httpMethod: method ?? "ALL", kind: "api", handler: null, calls: body ? collectCallNames(body) : [], middleware: [], line };
}

const servable = (path: string): boolean => isRoutePath(path) && path !== "/";

/** Rows of one request function: `sc.req` is its request parameter, `allowAnyMethod` whether a path alone is a route. */
function scanFunction(fn: Node, sc: Scope, allowAnyMethod: boolean, add: (r: RouteInfo) => void): void {
  const emit = (path: string, verbs: string[] | null, body: Node | null, line: number): void => {
    if (!servable(path)) return;
    if (verbs === null) {
      if (allowAnyMethod) add(route(path, null, body, line));
      return;
    }
    for (const v of verbs) add(route(path, v, body, line));
  };
  const walk = (node: Node, inherited: string[] | null): void => {
    // A function nested in the listener is its own scope (a helper, a callback); its branches are not dispatch.
    if (node !== fn && FUNCTION_TYPES.has(node.type)) return;
    if (node.type === "if_statement") {
      const cond = node.childForFieldName("condition");
      const facts = cond ? factsOf(cond, sc, false) : NONE;
      const verbs = facts.verbs ?? inherited;
      const consequence = node.childForFieldName("consequence");
      if (facts.path !== null) emit(facts.path, verbs, consequence, node.startPosition.row + 1);
      if (consequence) walk(consequence, verbs);
      const alternative = node.childForFieldName("alternative");
      if (alternative) walk(alternative, inherited); // an `else` does not carry the `if`'s method
      return;
    }
    if (node.type === "switch_statement") {
      let value = node.childForFieldName("value");
      while (value?.type === "parenthesized_expression" && value.namedChildren[0]) value = value.namedChildren[0];
      if (value && isPathExpr(value, sc.req)) {
        for (const c of node.childForFieldName("body")?.namedChildren ?? []) {
          const v = c.type === "switch_case" ? c.childForFieldName("value") : null;
          const path = v ? resolveString(v, sc.consts) : null;
          if (path !== null) emit(path, inherited, c, c.startPosition.row + 1);
        }
      }
    }
    for (const child of node.namedChildren) walk(child, inherited);
  };
  walk(fn, null);
}

interface TableEntry {
  path: string;
  method: string;
  handler: string;
  line: number;
}

/** `{ path: "/clubs", method: "GET", handler: listClubs }` entries of an array a dispatcher walks. */
function tableEntries(array: Node, consts: ReadonlyMap<string, string>): TableEntry[] {
  const out: TableEntry[] = [];
  for (const entry of array.namedChildren) {
    if (entry.type !== "object") continue;
    const fields = new Map<string, Node>();
    for (const pair of entry.namedChildren) {
      if (pair.type !== "pair") continue;
      const key = pair.childForFieldName("key");
      const value = pair.childForFieldName("value");
      if (key && value) fields.set(stripQuotes(key.text), value);
    }
    const pathNode = fields.get("path");
    const methodNode = fields.get("method");
    const handlerNode = fields.get("handler");
    const path = pathNode ? resolveString(pathNode, consts) : null;
    const method = methodNode ? resolveString(methodNode, consts) : null;
    const handler = handlerNode?.type === "identifier" ? handlerNode.text : handlerNode?.type === "member_expression" ? handlerNode.childForFieldName("property")?.text : null;
    if (path === null || !servable(path) || method === null || !HTTP_METHODS.has(method.toLowerCase()) || !handler) continue;
    out.push({ path, method: method.toUpperCase(), handler, line: entry.startPosition.row + 1 });
  }
  return out;
}

/** Does `scope` compare the variable's `method` AND `path` fields? */
function comparesBothFields(scope: Node, v: string): boolean {
  let method = false;
  let path = false;
  const visit = (node: Node): void => {
    if (node.type === "binary_expression") {
      const op = node.childForFieldName("operator")?.text;
      if (op === "===" || op === "==") {
        for (const side of [node.childForFieldName("left"), node.childForFieldName("right")]) {
          if (side?.type !== "member_expression" || side.childForFieldName("object")?.text !== v) continue;
          const prop = side.childForFieldName("property")?.text;
          if (prop === "method") method = true;
          else if (prop === "path") path = true;
        }
      }
    }
    for (const c of node.namedChildren) visit(c);
  };
  visit(scope);
  return method && path;
}

/** The name a `for (const r of routes)` binds. */
function loopVariable(loop: Node): string | null {
  const left = loop.childForFieldName("left");
  if (!left) return null;
  if (left.type === "identifier") return left.text;
  return left.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
}

export function extractNodeHttpRoutes(root: Node, routes: RouteInfo[]): void {
  const listeners: Node[] = [];
  const functions: Node[] = [];
  const tables = new Map<string, Node>();
  const declaredTimes = new Map<string, number>();
  const dispatched = new Set<string>();
  let callsHandler = false;
  const find = (node: Node): void => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const name = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : callee?.text;
      if (name === "createServer") {
        const fn = listenerOf(node, root);
        if (fn && !listeners.includes(fn)) listeners.push(fn);
      } else if (name === "handler" && callee?.type === "member_expression") {
        callsHandler = true;
      } else if (name === "find" && callee?.type === "member_expression") {
        // `routes.find((r) => r.method === req.method && r.path === pathname)`
        const object = callee.childForFieldName("object");
        const cb = node.childForFieldName("arguments")?.namedChildren[0];
        const v = cb && FUNCTION_TYPES.has(cb.type) ? firstParamName(cb) : null;
        if (object?.type === "identifier" && cb && v && comparesBothFields(cb, v)) dispatched.add(object.text);
      }
    } else if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      if (name?.type === "identifier") {
        declaredTimes.set(name.text, (declaredTimes.get(name.text) ?? 0) + 1);
        if (value?.type === "array") tables.set(name.text, value);
      }
    } else if (node.type === "for_in_statement" && node.childForFieldName("operator")?.text === "of") {
      // `for (const r of routes) if (r.method === req.method && r.path === pathname) …`
      const right = node.childForFieldName("right");
      const body = node.childForFieldName("body");
      const v = loopVariable(node);
      if (right?.type === "identifier" && body && v && comparesBothFields(body, v)) dispatched.add(right.text);
    }
    if (FUNCTION_TYPES.has(node.type)) functions.push(node);
    for (const child of node.namedChildren) find(child);
  };
  find(root);

  const rows: RouteInfo[] = [];
  const consts = fileConstants(root);
  for (const fn of listeners) {
    const req = firstParamName(fn);
    if (req) scanFunction(fn, { req, consts }, true, (r) => rows.push(r));
  }
  // A route module a server file hands the request to: its own method and path comparisons are the evidence.
  for (const fn of functions) {
    if (listeners.includes(fn)) continue;
    const params = fn.childForFieldName("parameters");
    const names = (params ? params.namedChildren : []).slice(0, 3).flatMap((p) => (p.type === "identifier" ? [p.text] : []));
    if (!names.length) continue;
    const text = fn.text;
    for (const req of names) {
      if (text.includes(`${req}.method`)) scanFunction(fn, { req, consts }, false, (r) => rows.push(r));
    }
  }
  // A data table walked by a dispatcher that compares both fields and calls the handler.
  if (callsHandler) {
    for (const name of dispatched) {
      const array = tables.get(name);
      if (!array || declaredTimes.get(name) !== 1) continue;
      for (const e of tableEntries(array, consts)) {
        rows.push({ path: e.path, httpMethod: e.method, kind: "api", handler: e.handler, calls: [], middleware: [], line: e.line });
      }
    }
  }

  // A row without a method yields to the same path claimed with one.
  const withMethod = new Set(rows.filter((r) => r.httpMethod !== "ALL").map((r) => r.path));
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.httpMethod === "ALL" && withMethod.has(r.path)) continue;
    const key = `${r.httpMethod} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push(r);
  }
}
