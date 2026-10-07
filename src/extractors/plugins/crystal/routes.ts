import type { ClassInfo, RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, findEndLine } from "../shared/regex-base.js";
import { CRYSTAL_CALL_PATTERNS, extractCrystalLocalTypes } from "./calls.js";

const VERBS = "get|post|put|patch|delete|options|head";

/** `get "/users/:id" do |env|` (Kemal, Lucky) — a route whose block is its handler. */
const BLOCK_ROUTE = new RegExp(String.raw`^\s*(${VERBS})\s+"(\/[^"]*)"\s*(?:,\s*:\w+\s*)?do\b`);
/** A top-level block registered now and run later: a route, a filter, an error page, a socket. */
const DEFERRED_OPENER = new RegExp(String.raw`^\s*(?:${VERBS}|ws|before_\w+|after_\w+|error|route|nested_route)\b.*\bdo\b(?:\s*\|[^|]*\|)?\s*$`);
/**
 * Amber: `get "/posts/:id", PostController, :show`. A macro-spliced namespace
 * (`{{namespace}}::Videos`) is dropped: the class is found by its own name.
 */
const AMBER_ROUTE = new RegExp(String.raw`^\s*(${VERBS})\s+"([^"]*)"\s*,\s*(?:\{\{\s*\w+\s*\}\}::)?((?:[A-Z]\w*::)*[A-Z]\w*)\s*,\s*:(\w+)`);
/** Amber: `resources "/posts", PostController, only: [:index, :show]`. */
const AMBER_RESOURCES = /^\s*resources\s+"([^"]*)"\s*,\s*((?:[A-Z]\w*::)*[A-Z]\w*)(.*)$/;
/** Amber: `routes :api, "/api" do` — the block's routes sit under the prefix. */
const AMBER_SCOPE = /^\s*routes\s+:\w+\s*(?:,\s*"([^"]*)")?\s*do\b/;
/** Marten: `path "/articles/<pk:int>", ArticleDetailHandler, name: "article_detail"`. */
const MARTEN_PATH = /^\s*path\s+"([^"]*)"\s*,\s*((?:[A-Z]\w*::)*[A-Z]\w*)\b(?!::)/;
/** Athena (`@[ARTA::Get("/x")]`) and Spider-Gazelle (`@[AC::Route::GET("/x")]`) on a method. */
const ROUTE_ANNOTATION = /^\s*@\[(?:ARTA|ART|Athena::Routing::Annotations|AC::Route)::(Get|Post|Put|Patch|Delete|Head|Options|Route|GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\(\s*(?:path:\s*)?"([^"]*)"(.*)\)\]\s*$/;

/** Amber's RESTful actions → method + path suffix (`update` answers PATCH and PUT; PUT is reported). */
const AMBER_ACTIONS: Array<[string, string, string]> = [
  ["index", "GET", ""], ["new", "GET", "/new"], ["create", "POST", ""], ["show", "GET", "/:id"],
  ["edit", "GET", "/:id/edit"], ["update", "PUT", "/:id"], ["destroy", "DELETE", "/:id"],
];

/** Lucky's inferred routes: the action class's last name → method + suffix (`:id` is `<singular>_id`). */
const LUCKY_ACTIONS: Record<string, [string, string]> = {
  Index: ["GET", ""], New: ["GET", "/new"], Create: ["POST", ""], Show: ["GET", "/:id"],
  Edit: ["GET", "/:id/edit"], Update: ["PUT", "/:id"], Delete: ["DELETE", "/:id"],
};

/** `/users/:id` / `/articles/<pk:int>` → `/users/{id}` / `/articles/{pk}`. */
function crystalPath(path: string): string {
  return path.replace(/<(\w+)(?::\w+)?>/g, "{$1}").replace(/:(\w+)/g, "{$1}");
}

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  return joined.length > 1 ? joined.replace(/\/+$/, "") : "/";
}

function underscore(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}

function singularize(word: string): string {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/(ss|x|z|ch|sh)es$/.test(word)) return word.replace(/es$/, "");
  return /[^s]s$/.test(word) ? word.slice(0, -1) : word;
}

/** 1-based spans of every top-level block that runs after load (see `RegexLangSpec.deferredBlocks`). */
export function crystalRouteBlocks(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (DEFERRED_OPENER.test(lines[i]!)) spans.push([i + 1, findEndLine(lines, i, "indent") + 1]);
  }
  return spans;
}

/** The class whose body holds line `line` (1-based) — the innermost. */
function enclosing(classes: ClassInfo[], line: number): ClassInfo | undefined {
  return classes.filter((c) => c.line < line && line <= c.endLine).sort((a, b) => b.line - a.line)[0];
}

/**
 * Lucky's `route do` / `nested_route do`: the path is the action class's
 * name. `Admin::Users::Show` → `GET /admin/users/:user_id`; a nested route's
 * parent resource carries its id: `Projects::Tasks::Index` → `/projects/:project_id/tasks`.
 */
function luckyInferred(className: string, nested: boolean): { method: string; path: string } | null {
  const parts = className.split("::");
  const action = LUCKY_ACTIONS[parts.pop()!];
  const resource = parts.pop();
  if (!action || !resource) return null;
  const res = underscore(resource);
  const parent = nested ? parts.pop() : undefined;
  const segments = [...parts.map(underscore)];
  if (parent) segments.push(underscore(parent), `:${singularize(underscore(parent))}_id`);
  segments.push(res);
  return { method: action[0], path: "/" + segments.join("/") + action[1].replace(":id", `:${singularize(res)}_id`) };
}

/**
 * Crystal web routes:
 *  - Kemal / Lucky: `get "/x" do |env| … end` — the block is the handler;
 *    Lucky's `route do` / `nested_route do` infer the path from the action class;
 *  - Amber: `get "/x", Controller, :action` and `resources` under `routes :scope, "/prefix" do`;
 *  - Athena: `@[ARTA::Get("/x")]` on a controller method, under a class `@[ARTA::Route("/prefix")]`;
 *  - Spider-Gazelle: `@[AC::Route::GET("/x")]` on a method, under the class's `base "/prefix"`;
 *  - Marten: `path "/x/<pk:int>", Handler, name: "x"`.
 */
export function extractCrystalRoutes(lines: string[], classes: ClassInfo[], _filePath: string): RouteInfo[] {
  const text = lines.join("\n");
  if (!/\b(?:get|post|put|patch|delete|options|head|resources|path|route|nested_route)\b|@\[(?:ARTA?|Athena|AC)::/.test(text)) return [];
  const routes: RouteInfo[] = [];
  const push = (method: string | null, path: string, handler: string | null, line: number, calls: RouteInfo["calls"] = []) => {
    routes.push({ path: crystalPath(path), httpMethod: method, kind: "api", handler, calls, middleware: [], line });
  };
  // A block has no signature to type its locals: a call through one it binds
  // (`order = Order.find!(id)` … `order.save`) names the receiver's type itself.
  const blockCalls = (i: number) => {
    const end = findEndLine(lines, i, "indent");
    const calls = extractCallsFromBody(lines, i + 1, end, ["#"], CRYSTAL_CALL_PATTERNS);
    const locals = new Map(extractCrystalLocalTypes(lines.slice(i + 1, end)).map((l) => [l.name, l.type]));
    for (const call of calls) {
      const [head, member, ...rest] = call.name.split(".");
      const type = member && rest.length === 0 ? locals.get(head!) : undefined;
      if (type) call.receiverType = type;
    }
    return calls;
  };

  // Amber `routes … do` scopes: [startIdx, endIdx, prefix].
  const scopes: Array<[number, number, string]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = AMBER_SCOPE.exec(lines[i]!);
    if (m) scopes.push([i, findEndLine(lines, i, "indent"), m[1] ?? ""]);
  }
  const prefixAt = (i: number) => scopes.filter(([s, e]) => s < i && i < e).map(([, , p]) => p).join("");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let m: RegExpExecArray | null;
    if ((m = AMBER_ROUTE.exec(line))) {
      push(m[1]!.toUpperCase(), joinPath(prefixAt(i), m[2]!), `${m[3]}.${m[4]}`, i + 1);
    } else if ((m = BLOCK_ROUTE.exec(line))) {
      const cls = enclosing(classes, i + 1);
      // Spider-Gazelle's old `get "/:id", :show do` sits under the class's `base`.
      const base = cls ? classBase(lines, cls) : "";
      push(m[1]!.toUpperCase(), joinPath(base, m[2]!), null, i + 1, blockCalls(i));
    } else if ((m = /^\s*(nested_route|route)\s+do\b/.exec(line))) {
      const cls = enclosing(classes, i + 1);
      const inferred = cls ? luckyInferred(cls.name, m[1] === "nested_route") : null;
      if (inferred) push(inferred.method, inferred.path, null, i + 1, blockCalls(i));
    } else if ((m = AMBER_RESOURCES.exec(line))) {
      const only = /\bonly:\s*\[([^\]]*)\]/.exec(m[3]!)?.[1];
      const except = /\bexcept:\s*\[([^\]]*)\]/.exec(m[3]!)?.[1];
      const names = (list?: string) => new Set([...(list ?? "").matchAll(/:(\w+)/g)].map((a) => a[1]!));
      const keep = only ? names(only) : null;
      const drop = names(except);
      const base = joinPath(prefixAt(i), m[1]!);
      for (const [action, method, suffix] of AMBER_ACTIONS) {
        if ((keep && !keep.has(action)) || drop.has(action)) continue;
        push(method, base + suffix, `${m[2]}.${action}`, i + 1);
      }
    } else if ((m = MARTEN_PATH.exec(line))) {
      // `path "/blog", Blog::ROUTES` mounts a sub-router — the `\b(?!::)` keeps a constant path out.
      if (!/^[A-Z0-9_]+$/.test(m[2]!.split("::").pop()!)) push(null, m[1]!, m[2]!, i + 1);
    } else if ((m = ROUTE_ANNOTATION.exec(line))) {
      const fn = annotatedMethod(lines, i);
      const cls = enclosing(classes, i + 1);
      if (!fn) continue;
      const verb = m[1]!.toUpperCase();
      const methods = verb === "ROUTE" ? [...(m[3] ?? "").matchAll(/"(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)"/gi)].map((x) => x[1]!.toUpperCase()) : [verb];
      const path = joinPath(cls ? classBase(lines, cls) : "", m[2]!);
      for (const method of methods.length > 0 ? methods : [null]) push(method, path, cls ? `${cls.name.split("::").pop()}.${fn}` : fn, i + 1);
    }
  }
  return routes;
}

/** The method a run of annotation lines sits above. */
function annotatedMethod(lines: string[], i: number): string | null {
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*@\[/.test(lines[j]!) || !lines[j]!.trim()) continue;
    return /^\s*(?:(?:private|protected)\s+)?def\s+(?:self\.)?([a-z_]\w*[?!]?)/.exec(lines[j]!)?.[1] ?? null;
  }
  return null;
}

/**
 * A controller's path prefix: Athena's `@[ARTA::Route("/api")]` (or older
 * `@[ART::Prefix("api")]`) above the class, Spider-Gazelle's `base "/users"`
 * in its body.
 */
function classBase(lines: string[], cls: ClassInfo): string {
  for (let j = cls.line - 2; j >= 0 && /^\s*@\[/.test(lines[j]!); j--) {
    const m = /^\s*@\[(?:ARTA?|Athena::Routing::Annotations)::(?:Route|Prefix)\(\s*(?:path:\s*)?"([^"]*)"/.exec(lines[j]!);
    if (m) return m[1]!.startsWith("/") ? m[1]! : `/${m[1]}`;
  }
  for (let j = cls.line; j < Math.min(cls.endLine, lines.length); j++) {
    const m = /^\s*base\s+"([^"]*)"/.exec(lines[j]!);
    if (m) return m[1]!;
  }
  return "";
}
