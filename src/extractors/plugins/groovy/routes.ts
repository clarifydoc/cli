import type { ClassInfo, FunctionInfo, RouteInfo } from "../../../types/analysis.js";

/**
 * Groovy routes, three ways:
 *
 *  - Grails `UrlMappings.groovy` — literal mappings (`"/login"(controller:
 *    "auth", action: "login")`, `get "/api/x"(…)`), REST `resources:` /
 *    `resource:`, per-method action maps and `group "/prefix", { … }`.
 *    Templates naming `$controller` / `$action` are the convention below, not
 *    a route of their own.
 *  - Grails controllers by convention: the default mapping
 *    `"/$controller/$action?/$id?"` routes every public action of
 *    `grails-app/controllers/**\/BookController` at `/book/<action>`, on any
 *    method unless `static allowedMethods` names one. (The REST-API profile
 *    replaces that mapping with method-based templates this per-file pass
 *    cannot see; its literal mappings are still read.)
 *  - Spring MVC and Micronaut annotations (`@RequestMapping` / `@GetMapping`,
 *    `@Controller("/x")` / `@Get`), the same as in Java.
 *
 * Handlers are `Class.method`, as for Play.
 */
export function extractGroovyRoutes(lines: string[], classes: ClassInfo[], filePath: string): RouteInfo[] {
  if (/(?:^|\/)UrlMappings\.groovy$/.test(filePath) || lines.some((l) => /^\s*static\s+mappings\s*=\s*\{/.test(l))) {
    return extractUrlMappings(lines);
  }
  const routes: RouteInfo[] = [];
  for (const cls of classes) {
    if (/(?:^|\/)grails-app\/controllers\//.test(filePath) && /Controller$/.test(cls.name)) {
      routes.push(...grailsConventionRoutes(lines, cls));
    } else {
      routes.push(...annotationRoutes(lines, cls));
    }
  }
  return routes;
}

// ─── Grails ───────────────────────────────────────────────────────────────

/** `BookController` → `book`, `MyBookController` → `myBook` (Grails' property-name convention). */
function controllerSegment(className: string): string {
  const base = className.replace(/Controller$/, "");
  return base.charAt(0).toLowerCase() + base.slice(1);
}

/** `book` → `BookController`. */
function controllerClass(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1) + "Controller";
}

/** Members of a controller that are not actions. */
const NOT_ACTIONS = new Set(["beforeInterceptor", "afterInterceptor", "allowedMethods", "defaultAction", "scaffold", "responseFormats"]);

function grailsConventionRoutes(lines: string[], cls: ClassInfo): RouteInfo[] {
  const body = lines.slice(cls.line - 1, cls.endLine).join("\n");
  const allowed = new Map<string, string>();
  const am = body.match(/static\s+allowedMethods\s*=\s*\[([^\]]*)\]/);
  if (am) {
    for (const m of am[1]!.matchAll(/(\w+)\s*:\s*['"](\w+)['"]/g)) allowed.set(m[1]!, m[2]!.toUpperCase());
  }
  const segment = controllerSegment(cls.name);
  const routes: RouteInfo[] = [];
  for (const fn of cls.methods) {
    if (!isAction(lines, fn)) continue;
    routes.push({
      path: `/${segment}/${fn.name}`,
      httpMethod: allowed.get(fn.name) ?? null,
      kind: "api",
      handler: `${cls.name}.${fn.name}`,
      calls: [],
      middleware: [],
      line: fn.line,
    });
  }
  return routes;
}

function isAction(lines: string[], fn: FunctionInfo): boolean {
  if (!fn.isExported || NOT_ACTIONS.has(fn.name) || /\s/.test(fn.name)) return false;
  const decl = lines[fn.line - 1] ?? "";
  return !/\b(?:static|protected)\b/.test(decl);
}

/** `/book/$id?/edit(.$format)?` → `/book/{id}/edit`. */
function grailsPath(raw: string): string {
  const path = raw
    .replace(/\(\.\$\{?format\}?\)\??/g, "")
    .replace(/\$\{(\w+)\}\??/g, "{$1}")
    .replace(/\$(\w+)\??/g, "{$1}")
    .replace(/\/+$/, "");
  return path === "" ? "/" : path;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix) return path;
  return (prefix.replace(/\/+$/, "") + (path === "/" ? "" : path)) || "/";
}

/** `key: "value"` / `key: 'value'` arguments of one mapping. */
function mappingArgs(text: string): Map<string, string> {
  const args = new Map<string, string>();
  for (const m of text.matchAll(/(\w+)\s*:\s*['"]([^'"]*)['"]/g)) args.set(m[1]!, m[2]!);
  return args;
}

/** REST actions of `resources:` (a collection) and `resource:` (a singleton). */
const RESOURCES: ReadonlyArray<[string, string, string]> = [
  ["GET", "", "index"], ["GET", "/create", "create"], ["POST", "", "save"], ["GET", "/{id}", "show"],
  ["GET", "/{id}/edit", "edit"], ["PUT", "/{id}", "update"], ["PATCH", "/{id}", "patch"], ["DELETE", "/{id}", "delete"],
];
const RESOURCE: ReadonlyArray<[string, string, string]> = [
  ["GET", "", "show"], ["GET", "/create", "create"], ["POST", "", "save"], ["GET", "/edit", "edit"],
  ["PUT", "", "update"], ["PATCH", "", "patch"], ["DELETE", "", "delete"],
];

const MAPPING_RE = /^\s*(?:(get|post|put|delete|patch|head|options)\s+)?(?:name\s+\w+\s*:\s*)?(["'])([^"']*)\2\s*(?:\(([^)]*)\))?\s*(\{)?/i;
const GROUP_RE = /^\s*group\s+(["'])([^"']*)\1\s*,\s*\{/;

function extractUrlMappings(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const groups: Array<{ prefix: string; depth: number }> = [];
  let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prefix = groups.map((g) => g.prefix).join("");
    const group = GROUP_RE.exec(line);
    const m = group ? null : MAPPING_RE.exec(line);
    if (group) {
      groups.push({ prefix: grailsPath(group[2]!), depth });
    } else if (m && m[3]!.startsWith("/") && !/\$\{?(?:controller|action)\b/.test(m[3]!)) {
      const path = joinPath(prefix, grailsPath(m[3]!));
      const args = mappingArgs(m[4] ?? "");
      const add = (method: string | null, routePath: string, controller: string, action: string) =>
        routes.push({
          path: routePath,
          httpMethod: method,
          kind: "api",
          handler: `${controllerClass(controller)}.${action}`,
          calls: [],
          middleware: [],
          line: i + 1,
        });
      const verb = (m[1]?.toUpperCase() ?? args.get("method")?.toUpperCase()) || null;
      const resources = args.get("resources");
      const resource = args.get("resource");
      if (resources || resource) {
        for (const [method, suffix, action] of resources ? RESOURCES : RESOURCE) {
          add(method, path === "/" ? suffix || "/" : path + suffix, (resources ?? resource)!, action);
        }
      } else if (args.has("controller")) {
        // `"/api/books"(controller: "book") { action = [GET: "list", POST: "save"] }`
        const actionMap = m[5] ? perMethodActions(lines, i) : null;
        if (actionMap && actionMap.size > 0 && !args.has("action")) {
          for (const [method, action] of actionMap) add(method, path, args.get("controller")!, action);
        } else {
          add(verb, path, args.get("controller")!, args.get("action") ?? "index");
        }
      }
      // `view:` / `uri:` / `redirect:` mappings route to no controller action.
    }
    for (const ch of line.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "")) {
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        while (groups.length > 0 && depth <= groups[groups.length - 1]!.depth) groups.pop();
      }
    }
  }
  return routes;
}

/** `action = [GET: "list", POST: "save"]` inside the block a mapping opens on line `i`. */
function perMethodActions(lines: string[], i: number): Map<string, string> | null {
  for (let j = i; j < Math.min(lines.length, i + 6); j++) {
    const m = lines[j]!.match(/\baction\s*=\s*\[([^\]]*)\]/);
    if (m) {
      const out = new Map<string, string>();
      for (const e of m[1]!.matchAll(/(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*:\s*['"](\w+)['"]/gi)) out.set(e[1]!.toUpperCase(), e[2]!);
      return out;
    }
    if (j > i && /\}/.test(lines[j]!)) break;
  }
  return null;
}

// ─── Spring MVC / Micronaut annotations ──────────────────────────────────

const METHOD_ANNOTATIONS: Record<string, string | null> = {
  GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT", DeleteMapping: "DELETE", PatchMapping: "PATCH",
  RequestMapping: null,
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE", Patch: "PATCH", Head: "HEAD", Options: "OPTIONS",
};

/** The path(s) an annotation's arguments name: `("/x")`, `(value = "/x")`, `(path = ["/a", "/b"])`, `(uri = "/x")`. */
function annotationPaths(args: string | undefined): string[] {
  if (!args) return [""];
  const named = args.match(/\b(?:value|path|uri|uris)\s*=\s*(\[[^\]]*\]|\{[^}]*\}|["'][^"']*["'])/);
  const source = named ? named[1]! : /^\s*(\[[^\]]*\]|\{[^}]*\}|["'][^"']*["'])/.exec(args)?.[1] ?? "";
  const paths = [...source.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]!);
  return paths.length > 0 ? paths : [""];
}

/** Annotations written on a declaration: the lines above (decorators) plus any inline ones. */
function annotationsOf(decorators: readonly string[], declLine: string): string[] {
  const inline = [...declLine.matchAll(/@([\w.]+(?:\([^)]*\))?)/g)].map((m) => m[1]!);
  return [...decorators, ...inline];
}

function parseAnnotation(text: string): { name: string; args: string | undefined } {
  const m = /^([\w.]+)(?:\((.*)\))?$/s.exec(text.trim());
  return { name: (m?.[1] ?? text).split(".").pop()!, args: m?.[2] };
}

function annotationRoutes(lines: string[], cls: ClassInfo): RouteInfo[] {
  const classAnns = annotationsOf(cls.decorators, lines[cls.line - 1] ?? "").map(parseAnnotation);
  const isController = classAnns.some((a) => /^(?:RestController|Controller)$/.test(a.name));
  if (!isController) return [];
  // Spring: `@RequestMapping("/api")` on the class; Micronaut: `@Controller("/api")`.
  const base = classAnns.find((a) => a.name === "RequestMapping" || (a.name === "Controller" && a.args))?.args;
  const prefixes = annotationPaths(base);
  const routes: RouteInfo[] = [];
  for (const fn of cls.methods) {
    for (const ann of annotationsOf(fn.decorators, lines[fn.line - 1] ?? "").map(parseAnnotation)) {
      if (!(ann.name in METHOD_ANNOTATIONS)) continue;
      // `@RequestMapping` states its method (or none: every method) in `method = RequestMethod.X`.
      const method = METHOD_ANNOTATIONS[ann.name] ?? /RequestMethod\.(\w+)/.exec(ann.args ?? "")?.[1]?.toUpperCase() ?? null;
      for (const prefix of prefixes) {
        for (const path of annotationPaths(ann.args)) {
          const joined = ("/" + [prefix, path].map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/"));
          routes.push({
            path: joined,
            httpMethod: method,
            kind: "api",
            handler: `${cls.name}.${fn.name}`,
            calls: [],
            middleware: [],
            line: fn.line,
          });
        }
      }
    }
  }
  return routes;
}
