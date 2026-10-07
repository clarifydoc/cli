import type { ClassInfo, FunctionInfo, RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, splitTopLevel, type CallPattern } from "../shared/regex-base.js";

/**
 * vibe.d routes, two ways:
 *
 *  - `URLRouter` registrations: `router.get("/users/:id", &getUser)`, `.post`,
 *    `.put`, `.patch`, `.delete_`, `.any`, `.match(HTTPMethod.GET, "/x", &h)`,
 *    chained (`router.get(…).post(…)`, also on continuation lines). The handler
 *    is the function a `&name` / `toDelegate(&name)` points at; an inline
 *    delegate is the route's own handler, whose calls are the route's.
 *  - Interfaces the framework generates routes from (`vibe.web.rest`,
 *    `vibe.web.web`). A REST interface — one carrying REST attributes or named
 *    by `registerRestInterface` / `RestInterfaceClient!I` in its file — and a
 *    class registered with `registerWebInterface` route every public method by
 *    vibe's own rules: `@method(HTTPMethod.X)` / `@path("x")` when given, else
 *    the name's prefix (`get`/`query` → GET, `post`/`add`/`create` → POST,
 *    `put`/`set` → PUT, `update`/`patch` → PATCH, `remove`/`erase`/`delete`
 *    → DELETE; a web interface's `index` → GET `/`; anything else POST) with
 *    the rest of the name lower_underscored (`getSomeInfo` → GET `some_info`).
 *    A REST method whose first parameter is `id` lives under `:id/`. The root
 *    is the interface's `@path`, or its own name under `@rootPathFromName`,
 *    under a prefix a same-file `registerRestInterface(…, "/api")` gives; a
 *    `@property` returning another interface of the file nests that one's
 *    routes under its name.
 *
 * Paths keep vibe's `:name` placeholders.
 */
export function extractDRoutes(lines: string[], classes: ClassInfo[], callPatterns: CallPattern[]): RouteInfo[] {
  if (!lines.some((l) => /\bvibe\b/.test(l))) return [];
  return [...routerRoutes(lines, callPatterns), ...interfaceRoutes(lines, classes)].sort((a, b) => a.line - b.line);
}

// ─── URLRouter ────────────────────────────────────────────────────────────

const VERBS: Record<string, string | null> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete_: "DELETE", head: "HEAD", options: "OPTIONS", any: null, match: null,
};
const ROUTER_CALL = /(?:\b([A-Za-z_]\w*)|^\s*|\))\s*\.(get|post|put|patch|delete_|head|options|any|match)\s*\(/g;

function routerRoutes(lines: string[], callPatterns: CallPattern[]): RouteInfo[] {
  // Router variables: `URLRouter r`, `auto r = new URLRouter`, and the usual names.
  const routers = new Set(["router", "routes", "urlRouter"]);
  for (const line of lines) {
    for (const m of line.matchAll(/\bURLRouter\s+([A-Za-z_]\w*)|\b([A-Za-z_]\w*)\s*=\s*new\s+URLRouter\b/g)) routers.add((m[1] ?? m[2])!);
  }
  const routes: RouteInfo[] = [];
  /** The router a `.get(` continuation line chains from: the statement's first word, lines above. */
  const chainRoot = (i: number): string | null => {
    for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
      const t = lines[j]!.trim();
      if (t === "" || t.startsWith("//") || t.startsWith(".")) continue;
      if (/;\s*$/.test(t)) return null;
      return /^([A-Za-z_]\w*)/.exec(t)?.[1] ?? null;
    }
    return null;
  };
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(ROUTER_CALL)) {
      const receiver = m[1] ?? (/^\s*\./.test(line.slice(0, m.index! + m[0].indexOf(".") + 1)) ? chainRoot(i) : null);
      // `router.get(…).post(…)`: the second call's receiver is the first's result.
      const chained = !m[1] && line[m.index!] === ")";
      if (!chained && (!receiver || !routers.has(receiver))) continue;
      if (chained && !routers.has(/^\s*([A-Za-z_]\w*)/.exec(line)?.[1] ?? "") && !routers.has(chainRoot(i) ?? "")) continue;
      const open = m.index! + m[0].length;
      const args = splitTopLevel(callArguments(lines, i, open));
      const verb = m[2]!;
      let method = VERBS[verb] ?? null;
      if (verb === "match") {
        method = /HTTPMethod\.(\w+)/.exec(args.shift() ?? "")?.[1] ?? null;
      }
      const path = /^\s*"([^"]*)"\s*$/.exec(args[0] ?? "")?.[1];
      if (path === undefined || !path.startsWith("/")) continue;
      const handlerArg = (args[1] ?? "").trim();
      const named = /^(?:toDelegate\s*\(\s*)?&\s*([A-Za-z_][\w.]*)\s*\)?$/.exec(handlerArg)?.[1];
      let calls: RouteInfo["calls"] = [];
      if (!named && /=>|\)\s*\{|\bdelegate\b|\bfunction\b/.test(handlerArg)) {
        // An inline delegate: its body is the route's handler.
        const at = line.indexOf(handlerArg.slice(0, 20), open);
        const body = handlerArg.search(/=>|\{/);
        if (at >= 0 && body >= 0) calls = extractCallsFromBody(lines, i + 1, inlineEnd(lines, i), ["//"], callPatterns, { line: i, column: at + body + 1 });
      }
      routes.push({
        path,
        httpMethod: method,
        kind: "api",
        handler: named ? named.slice(named.lastIndexOf(".") + 1) : null,
        calls,
        middleware: [],
        line: i + 1,
      });
    }
  });
  return routes;
}

/** 0-based line after the statement starting on line `i` (the line holding its `;`), exclusive. */
function inlineEnd(lines: string[], i: number): number {
  for (let j = i; j < Math.min(lines.length, i + 40); j++) if (/;\s*(?:\/\/.*)?$/.test(lines[j]!)) return j + 1;
  return i + 1;
}

/** The argument text of a call whose `(` ends just before column `from` on line `i`, up to its balanced `)`. */
function callArguments(lines: string[], i: number, from: number): string {
  let text = "";
  let depth = 1;
  for (let li = i; li < Math.min(lines.length, i + 12); li++) {
    const line = lines[li]!;
    for (let c = li === i ? from : 0; c < line.length; c++) {
      const ch = line[c]!;
      if (ch === '"') {
        const close = line.indexOf('"', c + 1);
        const end = close < 0 ? line.length : close;
        text += line.slice(c, end + 1);
        c = end;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if ((ch === ")" || ch === "]" || ch === "}") && --depth === 0) return text;
      text += ch;
    }
    text += " ";
  }
  return text;
}

// ─── REST and web interfaces ──────────────────────────────────────────────

const PREFIXES: ReadonlyArray<[string, string]> = [
  ["get", "GET"], ["query", "GET"], ["put", "PUT"], ["set", "PUT"], ["update", "PATCH"], ["patch", "PATCH"],
  ["add", "POST"], ["create", "POST"], ["post", "POST"], ["remove", "DELETE"], ["erase", "DELETE"], ["delete", "DELETE"],
];

/** vibe's REST attributes: an interface that carries one is a REST interface. */
const REST_ATTR = /^(?:path|method|rootPathFromName|queryParam|bodyParam|headerParam|requiresAuth|noRoute|before|after|contentType)\b/;
/** vibe's web-interface attributes: a class in a `vibe.web.web` module that carries one routes its methods. */
const WEB_ATTR = /^(?:path|method|auth|anyAuth|noAuth|noRoute|errorDisplay|contentType)\b/;
/** Attributes that guard a route. */
const GUARD_ATTR = /^(?:auth|requiresAuth|anyAuth|noAuth)\b/;

/** vibe's `MethodStyle.lowerUnderscored`: `getHTMLEntity` → `get_html_entity`, `MyID` → `myid`. */
export function lowerUnderscored(name: string): string {
  const upper = (ch: string | undefined): boolean => ch !== undefined && ch >= "A" && ch <= "Z";
  let ret = "";
  let start = 0;
  let i = 0;
  while (i < name.length) {
    while (i < name.length && (i + 1 >= name.length || upper(name[i + 1]))) i++; // an acronym
    while (i < name.length && !upper(name[i])) i++; // a word's lowercase part
    if (ret.length > 0) ret += "_";
    ret += name.slice(start, i);
    start = i;
    if (i < name.length) i++;
  }
  if (start < name.length) ret += "_" + name.slice(start);
  return ret.toLowerCase();
}

/** vibe's `concatURL`: exactly one `/` between the parts. */
function concatUrl(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (a.endsWith("/") && b.startsWith("/")) return a + b.slice(1);
  if (!a.endsWith("/") && !b.startsWith("/")) return `${a}/${b}`;
  return a + b;
}

/** A route path as the route map shows it: leading `/`, no trailing one. */
function tidy(path: string): string {
  const p = (path.startsWith("/") ? path : `/${path}`).replace(/\/+$/, "");
  return p || "/";
}

/** The string argument of an attribute: `path("/x")` → `/x`. */
function attrString(decorators: readonly string[], name: string): string | null {
  for (const d of decorators) {
    const m = new RegExp(String.raw`^${name}\s*\(\s*"([^"]*)"`).exec(d);
    if (m) return m[1]!;
  }
  return null;
}

function interfaceRoutes(lines: string[], classes: ClassInfo[]): RouteInfo[] {
  const text = lines.join("\n");
  const byName = new Map(classes.map((c) => [c.name, c]));
  const interfaces = classes.filter((c) => c.kind === "interface");

  // What the file registers: `new X` (directly, or through a variable bound to it) and a literal prefix.
  const boundTo = new Map<string, string>();
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s*=\s*new\s+([A-Za-z_]\w*)/g)) boundTo.set(m[1]!, m[2]!);
  for (const m of text.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*=\s*new\s+\1\b/g)) boundTo.set(m[2]!, m[1]!);
  const registered = (fn: string): Array<{ cls: string; prefix: string }> => {
    const out: Array<{ cls: string; prefix: string }> = [];
    for (const m of text.matchAll(new RegExp(String.raw`\b${fn}\s*(?:!\s*\w+\s*)?\(`, "g"))) {
      const args = splitTopLevel(callArgumentsOf(text, m.index! + m[0].length));
      const target = args.map((a) => /^\s*new\s+([A-Za-z_]\w*)/.exec(a)?.[1] ?? boundTo.get(a.trim())).find((c) => c && byName.has(c));
      const prefix = args.map((a) => /^\s*"(\/[^"]*)"\s*$/.exec(a)?.[1]).find((p) => p !== undefined) ?? "";
      if (target) out.push({ cls: target, prefix });
    }
    return out;
  };

  const routes: RouteInfo[] = [];
  const emit = (surface: ClassInfo, base: string, rest: boolean, implementer: ClassInfo | undefined, seen: Set<string>): void => {
    if (seen.has(surface.name)) return;
    seen.add(surface.name);
    for (const m of surface.methods) {
      if (m.name === surface.name || !m.isExported || m.decorators.some((d) => /^noRoute\b/.test(d))) continue;
      const decl = lines[m.line - 1] ?? "";
      if (/\bstatic\b/.test(decl)) continue;
      const property = m.decorators.some((d) => /^property\b/.test(d));
      // A getter returning another interface of the file nests its routes.
      const nested = property && m.params.length === 0 ? byName.get((m.returnType ?? "").replace(/[^\w].*$/, "")) : undefined;
      const { method, url } = routeOf(m, property, rest);
      if (nested && nested.kind === "interface") {
        emit(nested, concatUrl(concatUrl(base, url), "/"), rest, implementerOf(nested), seen);
        continue;
      }
      const owner = implementer && implementer.methods.some((x) => x.name === m.name) ? implementer : surface;
      routes.push({
        path: tidy(concatUrl(base, url)),
        httpMethod: method,
        kind: "api",
        handler: `${owner.name}.${m.name}`,
        calls: [],
        middleware: m.decorators.filter((d) => GUARD_ATTR.test(d)),
        line: m.line,
      });
    }
  };
  const implementerOf = (iface: ClassInfo): ClassInfo | undefined =>
    classes.find((c) => c.kind !== "interface" && (c.extends === iface.name || c.implements.includes(iface.name)));
  const rootOf = (c: ClassInfo, prefix: string): string => {
    const path = attrString(c.decorators, "path");
    if (path !== null) return concatUrl(prefix || "/", path);
    if (c.decorators.some((d) => /^rootPathFromName\b/.test(d))) return concatUrl(prefix || "/", lowerUnderscored(c.name));
    return prefix || "/";
  };

  // REST interfaces.
  const restRegistrations = registered("registerRestInterface");
  const named = new Set([...text.matchAll(/\b(?:RestInterfaceClient|serveRestJSClient|registerRestInterface)\s*!\s*\(?\s*([A-Za-z_]\w*)/g)].map((m) => m[1]!));
  const nestedInterfaces = new Set(interfaces.flatMap((i) => i.methods.map((m) => (m.returnType ?? "").replace(/[^\w].*$/, ""))));
  const seen = new Set<string>();
  for (const iface of interfaces) {
    if (nestedInterfaces.has(iface.name)) continue; // emitted under the interface that returns it
    const impl = implementerOf(iface);
    const reg = restRegistrations.find((r) => r.cls === iface.name || r.cls === impl?.name);
    const isRest = reg !== undefined || named.has(iface.name) || iface.decorators.some((d) => REST_ATTR.test(d)) ||
      iface.methods.some((m) => m.decorators.some((d) => REST_ATTR.test(d)));
    if (isRest) emit(iface, rootOf(iface, reg?.prefix ?? ""), true, impl, seen);
  }

  // Web interfaces: the registered class and the classes it inherits from in
  // this file — and, in a module of `vibe.web.web`, a class whose routes say
  // so themselves (`@path`, `@method`, `@auth`): it is registered elsewhere.
  const webModule = /^\s*import\s+vibe\.(?:web\.web|vibe|d)\b/m.test(text);
  const webRegistrations = registered("registerWebInterface");
  if (webModule) {
    for (const c of classes) {
      if (c.kind === "interface" || seen.has(c.name) || webRegistrations.some((r) => r.cls === c.name)) continue;
      // A REST interface's implementation repeats its attributes; its routes are the interface's.
      if ([c.extends, ...c.implements].some((b) => b && seen.has(b))) continue;
      if ([...c.decorators, ...c.methods.flatMap((m) => m.decorators)].some((d) => WEB_ATTR.test(d))) webRegistrations.push({ cls: c.name, prefix: "" });
    }
  }
  for (const { cls, prefix } of webRegistrations) {
    const root = rootOf(byName.get(cls)!, prefix);
    for (let c = byName.get(cls); c && !seen.has(c.name); c = c.extends ? byName.get(c.extends) : undefined) {
      if (c.kind === "interface") break;
      emit(c, root, false, undefined, seen);
    }
  }
  return routes;
}

/** HTTP method and relative URL of one interface method, by vibe's rules. */
function routeOf(m: FunctionInfo, property: boolean, rest: boolean): { method: string; url: string } {
  const explicitMethod = m.decorators.map((d) => /^method\s*\(\s*HTTPMethod\.(\w+)/.exec(d)?.[1]).find(Boolean) ?? null;
  const explicitPath = attrString(m.decorators, "path");
  let method = "POST";
  let name = m.name;
  if (property) method = m.params.length === 0 ? "GET" : "PUT";
  else {
    const hit = PREFIXES.find(([p]) => m.name.startsWith(p) && (m.name.length === p.length || !/[a-z]/.test(m.name[p.length]!)));
    if (hit) {
      method = hit[1];
      name = m.name.slice(hit[0].length) || "/";
    } else if (!rest && m.name === "index") {
      method = "GET";
      name = "/";
    }
  }
  if (explicitMethod) method = explicitMethod.toUpperCase();
  let url = explicitPath ?? (name === "/" ? "/" : lowerUnderscored(name.replace(/_$/, "")));
  if (rest && explicitPath === null && m.params[0]?.name === "id") url = ":id" + (url.startsWith("/") ? url : `/${url}`);
  return { method, url };
}

/** Like `callArguments`, over the whole text from an offset just past `(`. */
function callArgumentsOf(text: string, from: number): string {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"') {
      const close = text.indexOf('"', i + 1);
      if (close < 0) break;
      i = close;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return text.slice(from, i);
  }
  return text.slice(from, Math.min(text.length, from + 400));
}
