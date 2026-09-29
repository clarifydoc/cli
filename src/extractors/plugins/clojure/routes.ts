import type { ClassInfo, FunctionInfo, ParamInfo, PropertyInfo, RouteInfo, RouteParamBinding, RouteParamInfo } from "../../../types/analysis.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta, boundParam, inferredParam, pathParamNames } from "../../shared/route-metadata.js";
import type { Form, SeqForm, StringForm, SymbolForm } from "./forms.js";
import { isKeyword, isSymbol, mapGet, printForm, tryReadFirst, tryReadForms, walk } from "./forms.js";

/**
 * Clojure web routes with their attribute layer, read from the form tree:
 *
 *   - Compojure `(GET "/users/:id" [id :as req] (get-user id))` — the binding
 *     vector / map says where each name comes from (`:params` → query, `:body`
 *     → body, `:headers` → header, `:as` → the request), and the body's
 *     `(:body req)` / `(get-in req [:params :q])` reads add fields.
 *   - reitit `["/users/:id" {:get {:handler h :parameters {:path {:id int?}}}}]`
 *     — nested vectors prefix their children, route data `:middleware` and
 *     `:swagger {:security …}` are guards, `:parameters` are typed bindings.
 *   - buddy: `(wrap-authentication h backend)` / `(wrap-routes h wrap-auth)` /
 *     `(restrict h {:handler authenticated?})` anywhere in the file guard every
 *     route the file defines; a `jws`/`session`/`token`/`basic` backend names
 *     the scheme.
 */

const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ANY"]);
const REITIT_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);
const AUTH_MW_RE = /(?:^|\/)wrap-[\w-]*(?:auth|session|token|jwt|login|secure|permission|role|admin|restrict|authoriz|csrf-check|identity)[\w-]*$/i;
const BACKEND_RE = /(?:^|\/)(jws|jwe|jwt|session|token|basic|http-basic)(?:-backend)?$/;

// ─── Bindings ────────────────────────────────────────────────────────────────

/** Request map keys → where the value comes from. */
function bindingForKey(key: string): RouteParamBinding | "services" | null {
  switch (key) {
    case "params": case "query-params": case "query": return "query";
    case "body": case "body-params": case "json-params": case "edn-params": case "transit-params": return "body";
    case "form-params": case "multipart-params": return "form";
    case "headers": return "header";
    case "route-params": case "path-params": return "route";
    case "as": return "services";
    default: return null;
  }
}

/** Names a destructuring pattern binds: `x`, `{:keys [a b]}`, `{name :name}`, `[a b]`. */
function patternNames(f: Form): string[] {
  if (f.kind === "symbol") return f.name === "&" || f.name === "_" ? [] : [f.name];
  if (f.kind === "vector") return f.items.flatMap(patternNames);
  if (f.kind === "map") {
    const names: string[] = [];
    for (const [k, v] of f.entries) {
      if (isKeyword(k, "keys") || isKeyword(k, "strs") || isKeyword(k, "syms")) {
        if (v.kind === "vector") for (const s of v.items) if (isSymbol(s)) names.push(s.name); else if (isKeyword(s)) names.push(s.name);
      } else if (isKeyword(k, "as") && isSymbol(v)) names.push(v.name);
      else if (isKeyword(k, "or")) continue;
      else if (k.kind === "symbol" && (isKeyword(v) || v.kind === "string")) names.push(isKeyword(v) ? v.name : v.value);
      else names.push(...patternNames(k));
    }
    return names;
  }
  return [];
}

/**
 * Compojure's binding form. A vector reads from `:params` (route + query +
 * form merged): a name in the path is a route param, the rest are query; `:as
 * req` is the request. A map destructures the request itself, so each key
 * says where its names come from.
 */
function compojureBindingParams(binding: Form | undefined, path: string): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  if (!binding) return out;
  const push = (name: string, binding: RouteParamBinding | "services" | null, explicit: boolean): void => {
    if (out.some((p) => p.name === name)) return;
    if (binding === "services") out.push({ name, type: null, binding: "services", inferred: true });
    else if (explicit && binding) out.push(boundParam(name, null, binding));
    else out.push(inferredParam(name, null, path, binding));
  };
  if (binding.kind === "symbol") {
    if (binding.name !== "_") push(binding.name, "services", false);
    return out;
  }
  if (binding.kind === "vector") {
    for (let i = 0; i < binding.items.length; i++) {
      const item = binding.items[i]!;
      if (isKeyword(item, "as")) { const v = binding.items[++i]; if (isSymbol(v)) push(v.name, "services", false); continue; }
      if (isKeyword(item, "<<") || isKeyword(item, ":<<")) { i++; continue; } // coercer
      if (isSymbol(item, "&")) continue;
      if (item.kind === "map") {
        for (const [k, v] of item.entries) {
          if (isKeyword(k, "keys") && v.kind === "vector") for (const n of patternNames(v)) push(n, "query", false);
          else if (isKeyword(k, "as") && isSymbol(v)) push(v.name, "services", false);
          else if (isKeyword(k)) { const b = bindingForKey(k.name); for (const n of patternNames(v)) push(n, b, b !== null && k.name !== "params"); }
          else for (const n of patternNames(k)) push(n, "query", false);
        }
        continue;
      }
      for (const n of patternNames(item)) push(n, "query", false);
    }
    return out;
  }
  if (binding.kind === "map") {
    for (const [pattern, key] of binding.entries) {
      if (isKeyword(pattern, "keys") || isKeyword(pattern, "strs")) {
        // Top-level `{:keys [a b]}` reads the request map's own keys — `:params`, `:body` …
        for (const n of patternNames(key)) push(n, bindingForKey(n) ?? "services", true);
        continue;
      }
      if (isKeyword(pattern, "as") && isSymbol(key)) { push(key.name, "services", false); continue; }
      if (isKeyword(key)) {
        // `:params` is the merged route+query map, so the path decides; the others are explicit.
        const b = bindingForKey(key.name);
        for (const n of patternNames(pattern)) push(n, b, b !== null && key.name !== "params");
      }
    }
  }
  return out;
}

/**
 * Request reads inside a body: `(:body req)`, `(get-in req [:body :name])`,
 * `(-> req :params :q)`, `(get (:params req) :q)`, `(get-in req [:headers "x"])`.
 * Any symbol may be the request — the read is what identifies it.
 */
export function accessInForms(forms: Form[]): RouteParamInfo[] {
  const out: RouteParamInfo[] = [];
  const seen = new Set<string>();
  const add = (name: string, binding: RouteParamBinding): void => {
    const key = `${binding}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type: null, binding });
  };
  const keyName = (f: Form | undefined): string | null => (isKeyword(f) ? f.name : f?.kind === "string" ? f.value : null);
  const pathRead = (keys: Form[]): void => {
    const first = keyName(keys[0]);
    const b = first ? bindingForKey(first) : null;
    if (!b || b === "services") return;
    const second = keyName(keys[1]);
    add(second ?? first!, b);
  };
  for (const root of forms) {
    walk(root, (node) => {
      if (node.kind !== "list" || node.items.length === 0) return;
      const head = node.items[0]!;
      // (:body req) / (:params req)
      if (isKeyword(head) && node.items.length === 2 && isSymbol(node.items[1])) {
        const b = bindingForKey(head.name);
        if (b && b !== "services") add(head.name, b);
        return;
      }
      if (!isSymbol(head)) return;
      // (get-in req [:body :name]) / (get-in req [:headers "x"])
      if (head.name === "get-in" && node.items[2]?.kind === "vector") pathRead(node.items[2].items);
      // (-> req :params :q)
      if ((head.name === "->" || head.name === "some->") && isSymbol(node.items[1])) {
        const keys = node.items.slice(2).filter((k) => isKeyword(k) || k.kind === "string");
        if (keys.length > 0 && keys.length === node.items.length - 2) pathRead(keys);
      }
      // (get (:params req) :q)
      if (head.name === "get" && node.items[1]?.kind === "list" && isKeyword(node.items[1].items[0]) && node.items[1].items.length === 2) {
        const inner = node.items[1].items[0]!.kind === "keyword" ? node.items[1].items[0].name : "";
        const b = bindingForKey(inner);
        const k = keyName(node.items[2]);
        if (b && b !== "services" && k) add(k, b);
      }
    });
  }
  return out;
}

/** `extractRequestAccess` for a `defn` body: read what it can, silently nothing otherwise. */
export function clojureRequestAccess(bodyLines: string[]): RouteParamInfo[] {
  const text = bodyLines.join("\n");
  if (!/\(:(?:body|params|headers|query-params|form-params|body-params|json-params)\s|get-in|->\s/.test(text)) return [];
  const forms = tryReadForms(text);
  return forms ? accessInForms(forms) : [];
}

// ─── Guards ──────────────────────────────────────────────────────────────────

function short(text: string): string {
  return text.length > 80 ? text.slice(0, 77) + "…" : text;
}

/** A middleware reference (`wrap-auth`, `[wrap-auth opts]`, `auth/wrap-jwt`) → guard or plain name. */
function middlewareEntry(f: Form): { name: string; guard: GuardAttr | null } {
  const head = f.kind === "vector" ? f.items[0] : f;
  const name = head && isSymbol(head) ? head.name : printForm(f);
  const text = short(printForm(f));
  if (AUTH_MW_RE.test(name)) return { name, guard: { text, policies: [name.replace(/^.*\//, "")] } };
  return { name, guard: null };
}

/**
 * File-level guards: buddy's `wrap-authentication` / `wrap-authorization`
 * wrapped around the handler, `(wrap-routes h wrap-x)`, `(restrict h {:handler
 * p})`. Where a backend is constructed in the same file (`(backends/jws …)`,
 * `(session-backend)`), its kind is the scheme.
 */
interface FileGuard {
  guard: GuardAttr;
  /** The `defroutes` name the wrapper is applied to, when it names one in this file; null = every route. */
  target: string | null;
}

function fileGuards(forms: Form[]): FileGuard[] {
  const guards: FileGuard[] = [];
  const schemes = new Set<string>();
  const seen = new Set<string>();
  const defroutes = new Set<string>();
  for (const root of forms) {
    walk(root, (node) => {
      if (node.kind === "list" && isSymbol(node.items[0]) && /(?:^|\/)defroutes$/.test(node.items[0].name) && isSymbol(node.items[1])) defroutes.add(node.items[1].name);
    });
  }
  const push = (g: GuardAttr, wrapped: Form | undefined): void => {
    if (seen.has(g.text)) return;
    seen.add(g.text);
    const target = isSymbol(wrapped) && defroutes.has(wrapped.name) ? wrapped.name : null;
    guards.push({ guard: g, target });
  };
  for (const root of forms) {
    walk(root, (node, parents) => {
      if (node.kind === "symbol") {
        const m = node.name.match(BACKEND_RE);
        if (m && /backend/.test(node.name)) schemes.add(m[1]!);
        return;
      }
      if (node.kind !== "list" || !isSymbol(node.items[0])) return;
      const head = node.items[0].name;
      // In `(-> app-routes (wrap-authentication backend))` the handler is the threaded first form.
      const parent = parents[parents.length - 1];
      const threaded = parent?.kind === "list" && isSymbol(parent.items[0]) && /^(?:->|some->)$/.test(parent.items[0].name) ? parent.items[1] : undefined;
      if (AUTH_MW_RE.test(head)) {
        const arg = node.items.length >= 2 ? node.items[node.items.length - 1] : undefined;
        const name = head.replace(/^.*\//, "");
        const text = arg && !(threaded === undefined && node.items.length === 2) ? `${name} ${short(printForm(arg))}` : name;
        push({ text, policies: [name] }, threaded ?? node.items[1]);
        return;
      }
      if (head === "wrap-routes") {
        if (node.items[1]?.kind === "list") return; // inline routes — handled by the visitor
        for (const mw of node.items.slice(2)) {
          const e = middlewareEntry(mw);
          if (e.guard) push(e.guard, node.items[1]);
        }
        return;
      }
      if (head === "restrict" || head === "buddy.auth.accessrules/restrict") {
        const rule = mapGet(node.items[2], "handler");
        const p = rule ? printForm(rule) : "restrict";
        push({ text: `restrict {:handler ${p}}`, policies: [p] }, threaded ?? node.items[1]);
      }
    });
  }
  if (schemes.size > 0 && guards.length > 0) guards[0] = { ...guards[0]!, guard: { ...guards[0]!.guard, schemes: [...schemes] } };
  return guards;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

function joinPath(prefixes: string[], path: string): string {
  const parts = [...prefixes, path].join("/").split("/").filter(Boolean);
  return "/" + parts.join("/");
}

interface Ctx {
  prefixes: string[];
  inherited: GuardAttr[];
  middleware: string[];
  /** reitit route data inherited from parent vectors (`:parameters`, `:swagger`). */
  data: Form[];
  /** The enclosing `defroutes` name, for file-level guards that target one. */
  routesName: string | null;
}

/** reitit route data → guards, middleware names, params. */
function reititData(data: Form | undefined, path: string): { guards: GuardAttr[]; middleware: string[]; params: RouteParamInfo[] } {
  const guards: GuardAttr[] = [];
  const middleware: string[] = [];
  const params: RouteParamInfo[] = [];
  if (!data || data.kind !== "map") return { guards, middleware, params };
  const mw = mapGet(data, "middleware");
  if (mw?.kind === "vector") {
    for (const item of mw.items) {
      const e = middlewareEntry(item);
      if (e.guard) guards.push(e.guard);
      else middleware.push(e.name);
    }
  }
  const security = mapGet(mapGet(data, "swagger"), "security") ?? mapGet(data, "security");
  if (security?.kind === "vector") {
    const schemes: string[] = [];
    for (const item of security.items) {
      if (item.kind === "map") {
        for (const [k] of item.entries) {
          if (isKeyword(k)) schemes.push(k.name);
          else if (k.kind === "string") schemes.push(k.value);
        }
      } else if (isKeyword(item)) schemes.push(item.name);
    }
    if (schemes.length > 0) guards.push({ text: `security ${schemes.join(",")}`, schemes });
    else guards.push({ text: "security []", anonymous: true });
  }
  const parameters = mapGet(data, "parameters");
  if (parameters?.kind === "map") {
    for (const [k, v] of parameters.entries) {
      if (!isKeyword(k)) continue;
      const binding: RouteParamBinding | null = k.name === "body" ? "body" : k.name === "query" ? "query" : k.name === "path" ? "route" : k.name === "header" ? "header" : k.name === "form" || k.name === "multipart" ? "form" : null;
      if (!binding) continue;
      if (v.kind === "map") {
        for (const [pk, pv] of v.entries) {
          const name = isKeyword(pk) ? pk.name : pk.kind === "string" ? pk.value : pk.kind === "list" && isKeyword(pk.items[1]) ? pk.items[1].name : printForm(pk);
          params.push(boundParam(name, printForm(pv), binding));
        }
      } else if (v.kind === "vector" && v.items.length > 0 && isKeyword(v.items[0], "map")) {
        for (const entry of v.items.slice(1)) {
          if (entry.kind !== "vector" || !isKeyword(entry.items[0])) continue;
          params.push(boundParam(entry.items[0].name, printForm(entry.items[entry.items.length - 1]!), binding));
        }
      } else {
        params.push(boundParam(binding === "body" ? "body" : k.name, printForm(v), binding));
      }
    }
  }
  void path;
  return { guards, middleware, params };
}

export function extractClojureRoutes(lines: string[]): RouteInfo[] {
  const forms = tryReadForms(lines.join("\n"));
  if (!forms) return extractClojureRoutesByLine(lines);
  const routes: RouteInfo[] = [];
  const fileLevel = fileGuards(forms);
  const fileFor = (ctx: Ctx): GuardAttr[] => fileLevel.filter((g) => g.target === null || g.target === ctx.routesName).map((g) => g.guard);

  const compojure = (node: SeqForm, ctx: Ctx): void => {
    const verb = (node.items[0] as SymbolForm).name.replace(/^.*\//, "");
    const pathForm = node.items[1];
    if (!pathForm || pathForm.kind !== "string") return;
    const path = joinPath(ctx.prefixes, pathForm.value);
    const binding = node.items[2];
    const body = node.items.slice(3);
    let handler: string | null = null;
    const first = body[0];
    if (first?.kind === "list" && isSymbol(first.items[0])) handler = first.items[0].name;
    else if (isSymbol(first)) handler = first.name;
    const params = compojureBindingParams(binding, path);
    const tokens = pathParamNames(path);
    for (const acc of accessInForms(body)) {
      if (params.some((p) => p.name === acc.name)) continue;
      params.push(tokens.has(acc.name.toLowerCase()) ? { ...acc, binding: "route", inferred: true } : { ...acc, inferred: true });
    }
    const route: RouteInfo = {
      path,
      httpMethod: verb === "ANY" ? null : verb,
      kind: "api",
      handler,
      calls: [],
      middleware: [...ctx.middleware],
      line: node.line,
    };
    applyRouteMeta(route, { inheritedGuards: [...fileFor(ctx), ...ctx.inherited], params });
    routes.push(route);
  };

  const reitit = (node: SeqForm, ctx: Ctx): void => {
    const pathForm = node.items[0] as StringForm;
    const path = joinPath(ctx.prefixes, pathForm.value);
    const data = node.items[1]?.kind === "map" ? node.items[1] : undefined;
    const own = reititData(data, path);
    const children = node.items.slice(1).filter((c): c is SeqForm => c.kind === "vector" && c.items[0]?.kind === "string" && c.items[0].value.startsWith("/"));
    if (data) {
      for (const [k, v] of data.entries) {
        if (!isKeyword(k) || !REITIT_VERBS.has(k.name)) continue;
        let handler: string | null = null;
        let verbMeta = { guards: [] as GuardAttr[], middleware: [] as string[], params: [] as RouteParamInfo[] };
        if (isSymbol(v)) handler = v.name === "handler" ? null : v.name;
        else if (v.kind === "map") {
          const h = mapGet(v, "handler");
          handler = isSymbol(h) ? h.name : h?.kind === "list" && isSymbol(h.items[0]) ? h.items[0].name : null;
          verbMeta = reititData(v, path);
        }
        const params = [...own.params, ...verbMeta.params];
        const tokens = pathParamNames(path);
        for (const t of tokens) if (!params.some((p) => p.name.toLowerCase() === t)) params.push({ name: t, type: null, binding: "route", inferred: true });
        const route: RouteInfo = {
          path,
          httpMethod: k.name.toUpperCase(),
          kind: "api",
          handler,
          calls: [],
          middleware: [...ctx.middleware, ...own.middleware, ...verbMeta.middleware],
          line: k.line,
        };
        applyRouteMeta(route, { inheritedGuards: [...fileFor(ctx), ...ctx.inherited, ...own.guards], guards: verbMeta.guards, params });
        routes.push(route);
      }
    }
    // A bare `["/path" handler-sym]`, no data map: a reitit route with any method.
    if (!data && node.items.length === 2 && isSymbol(node.items[1])) {
      const route: RouteInfo = { path, httpMethod: null, kind: "api", handler: node.items[1].name, calls: [], middleware: [...ctx.middleware], line: node.line };
      applyRouteMeta(route, { inheritedGuards: [...fileFor(ctx), ...ctx.inherited] });
      routes.push(route);
    }
    const childCtx: Ctx = {
      prefixes: [...ctx.prefixes, pathForm.value],
      inherited: [...ctx.inherited, ...own.guards],
      middleware: [...ctx.middleware, ...own.middleware],
      data: data ? [...ctx.data, data] : ctx.data,
      routesName: ctx.routesName,
    };
    for (const child of children) reitit(child, childCtx);
  };

  const visit = (node: Form, ctx: Ctx): void => {
    if (node.kind === "list" && isSymbol(node.items[0])) {
      const head = node.items[0].name.replace(/^.*\//, "");
      if (VERBS.has(head) && node.items[1]?.kind === "string") { compojure(node, ctx); return; }
      if (head === "context" && node.items[1]?.kind === "string") {
        const inner: Ctx = { ...ctx, prefixes: [...ctx.prefixes, node.items[1].value] };
        for (const c of node.items.slice(3)) visit(c, inner);
        return;
      }
      if (head === "wrap-routes" && node.items[1]) {
        const guards = node.items.slice(2).map(middlewareEntry).flatMap((e) => (e.guard ? [e.guard] : []));
        visit(node.items[1], { ...ctx, inherited: [...ctx.inherited, ...guards] });
        return;
      }
      if (head === "defroutes" && isSymbol(node.items[1])) {
        const inner: Ctx = { ...ctx, routesName: node.items[1].name };
        for (const c of node.items.slice(2)) visit(c, inner);
        return;
      }
      for (const c of node.items.slice(1)) visit(c, ctx);
      return;
    }
    if (node.kind === "vector" && node.items[0]?.kind === "string" && node.items[0].value.startsWith("/")) {
      reitit(node, ctx);
      return;
    }
    if (node.kind === "list" || node.kind === "vector" || node.kind === "set") for (const c of node.items) visit(c, ctx);
    else if (node.kind === "map") for (const [, v] of node.entries) visit(v, ctx);
  };

  for (const f of forms) visit(f, { prefixes: [], inherited: [], middleware: [], data: [], routesName: null });
  return routes;
}

// ─── Line-based fallback (the pre-reader extractor, kept for unbalanced files) ──

const COMPOJURE_RE = /\(\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+"([^"]+)"/;
const COMPOJURE_HANDLER_RE = /\]\s*\(\s*([\w.!?<>=*+-]+[\w.!?<>=*+/-]*)/;
const CONTEXT_RE = /\(\s*context\s+"([^"]+)"/;
const REITIT_RE = /\[\s*"(\/[^"]*)"\s*\{([^}]*)\}/;
const REITIT_VERB_RE = /:(get|post|put|patch|delete|head|options)\s+([\w.!?*+-]+[\w.!?*+/-]*)?/g;

function parenDelta(line: string): number {
  const stripped = line.replace(/"(?:[^"\\]|\\.)*"/g, "").replace(/;.*$/, "");
  let d = 0;
  for (const ch of stripped) {
    if (ch === "(") d++;
    else if (ch === ")") d--;
  }
  return d;
}

function extractClojureRoutesByLine(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const contextStack: Array<{ depth: number; prefix: string }> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (/^\s*;/.test(line)) continue;
    const ctx = line.match(CONTEXT_RE);
    if (ctx) {
      contextStack.push({ depth: depth + parenDelta(line), prefix: ctx[1]! });
      depth += parenDelta(line);
      continue;
    }
    const prefixes = contextStack.map((c) => c.prefix);
    const comp = line.match(COMPOJURE_RE);
    if (comp) {
      routes.push({ path: joinPath(prefixes, comp[2]!), httpMethod: comp[1] === "ANY" ? null : comp[1]!, kind: "api", handler: line.match(COMPOJURE_HANDLER_RE)?.[1] ?? null, calls: [], middleware: [], line: lineNo });
    } else {
      const reitit = line.match(REITIT_RE);
      if (reitit) {
        REITIT_VERB_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = REITIT_VERB_RE.exec(reitit[2]!)) !== null) {
          routes.push({ path: joinPath(prefixes, reitit[1]!), httpMethod: m[1]!.toUpperCase(), kind: "api", handler: m[2] && m[2] !== "handler" ? m[2] : null, calls: [], middleware: [], line: lineNo });
        }
      }
    }
    depth += parenDelta(line);
    while (contextStack.length > 0 && depth < contextStack[contextStack.length - 1]!.depth) contextStack.pop();
  }
  return routes;
}

// ─── Functions: params from the arg vector ───────────────────────────────────

/** `(defn name "doc" [a {:keys [b]} & rest] …)` / multi-arity → the first arity's names. */
export function attachDefnParams(lines: string[], fns: FunctionInfo[]): void {
  for (const fn of fns) {
    const form = tryReadFirst(lines.slice(fn.line - 1, Math.min(lines.length, fn.line + 40)).join("\n"));
    if (!form || form.kind !== "list") continue;
    let args = form.items.find((f, i) => i >= 2 && f.kind === "vector");
    if (!args) {
      const arity = form.items.find((f, i) => i >= 2 && f.kind === "list" && f.items[0]?.kind === "vector");
      args = arity?.kind === "list" ? arity.items[0] : undefined;
    }
    if (!args || args.kind !== "vector") continue;
    const params: ParamInfo[] = [];
    for (let i = 0; i < args.items.length; i++) {
      const item = args.items[i]!;
      if (isSymbol(item, "&")) { i++; continue; } // variadic rest
      for (const n of patternNames(item)) if (!params.some((p) => p.name === n)) params.push({ name: n, type: null, defaultValue: null });
    }
    fn.params = params;
  }
}

// ─── Classes: record fields, Malli and Schema maps ───────────────────────────

function prop(name: string, type: string | null, required?: boolean): PropertyInfo {
  const p: PropertyInfo = { name, type, visibility: "public", isStatic: false, isReadonly: false };
  if (required) p.isRequired = true;
  return p;
}

/** Malli `[:map [:id int?] [:name {:optional true} string?]]` → properties. */
function malliProps(vec: Form): PropertyInfo[] {
  if (vec.kind !== "vector" || !isKeyword(vec.items[0], "map")) return [];
  const out: PropertyInfo[] = [];
  for (const entry of vec.items.slice(1)) {
    if (entry.kind !== "vector" || !isKeyword(entry.items[0]) || entry.items.length < 2) continue;
    const opts = entry.items[1]?.kind === "map" ? entry.items[1] : undefined;
    const optional = opts ? isSymbol(mapGet(opts, "optional"), "true") : false;
    const type = entry.items[entry.items.length - 1]!;
    out.push(prop(entry.items[0].name, printForm(type), !optional));
  }
  return out;
}

/** A value that reads as a schema (`s/Int`, `Address`, `[Line]`, `{…}`, `(s/maybe …)`) rather than a literal. */
function isSchemaValue(v: Form): boolean {
  if (v.kind === "symbol" || v.kind === "vector" || v.kind === "map") return true;
  return v.kind === "list" && isSymbol(v.items[0]) && v.items[0].name.includes("/");
}

/** Plumatic `{:id s/Int (s/optional-key :name) s/Str}` → properties; a map of literals is not a schema. */
function schemaProps(map: Form): PropertyInfo[] {
  if (map.kind !== "map" || map.entries.length === 0 || !map.entries.every(([, v]) => isSchemaValue(v))) return [];
  const out: PropertyInfo[] = [];
  for (const [k, v] of map.entries) {
    if (isKeyword(k)) out.push(prop(k.name, printForm(v), true));
    else if (k.kind === "list" && isSymbol(k.items[0]) && /optional-key$/.test(k.items[0].name) && isKeyword(k.items[1])) out.push(prop(k.items[1].name, printForm(v), false));
    else if (k.kind === "list" && isSymbol(k.items[0]) && /required-key$/.test(k.items[0].name) && isKeyword(k.items[1])) out.push(prop(k.items[1].name, printForm(v), true));
  }
  return out;
}

/**
 * Properties for the class forms the spec matches: `defrecord` fields
 * (untyped), a Malli `(def User [:map …])` / `(def User (m/schema [:map …]))`,
 * a Plumatic `(s/defschema User {…})`.
 */
export function attachClojureProperties(lines: string[], classes: ClassInfo[]): ClassInfo[] {
  const kept: ClassInfo[] = [];
  for (const cls of classes) {
    const form = tryReadFirst(lines.slice(cls.line - 1, Math.min(lines.length, cls.line + 80)).join("\n"));
    if (!form || form.kind !== "list" || !isSymbol(form.items[0])) { kept.push(cls); continue; }
    const head = form.items[0].name.replace(/^.*\//, "");
    let props: PropertyInfo[] = [];
    if (head === "defrecord" || head === "deftype") {
      const fields = form.items[2];
      if (fields?.kind === "vector") props = fields.items.flatMap((f) => (isSymbol(f) ? [prop(f.name, null)] : []));
    } else if (head === "def") {
      let value = form.items[form.items.length - 1]!;
      if (value.kind === "list" && isSymbol(value.items[0]) && /schema$/.test(value.items[0].name)) value = value.items[1] ?? value;
      props = value.kind === "map" ? schemaProps(value) : malliProps(value);
    } else if (head === "defschema") {
      const value = form.items[form.items.length - 1]!;
      props = value.kind === "map" ? schemaProps(value) : malliProps(value);
    }
    if (props.length > 0) cls.properties = props;
    // A capitalised `(def Name …)` matched on the chance it is a schema; one
    // whose value is not a map schema is a plain constant, not a class.
    if (head === "def" && props.length === 0) continue;
    kept.push(cls);
  }
  return kept;
}
