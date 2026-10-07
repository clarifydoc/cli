import type { RouteInfo } from "../../../types/analysis.js";
import { extractCallsFromBody, splitTopLevel, type CallPattern } from "../shared/regex-base.js";
import { nimBlockEnd } from "./source.js";

/**
 * Nim web routes:
 *
 *  - Jester: a `routes:` block (or a named `router x:`) whose entries are
 *    `get "/users/@id":` heads over an indented handler body. `@id` (also the
 *    optional `@id?`) is a path parameter → `{id}`; a `re"…"` route keeps its
 *    pattern. The body is the route's own handler, so its calls are the
 *    route's `calls`. `extend admin, "/admin"` mounts a router of the same
 *    file under a prefix (one of another file is not followed: its prefix
 *    would need the other file's routes).
 *  - Prologue: `app.addRoute("/x", handler, HttpPost)` (method list `@[HttpGet,
 *    HttpPost]`, default GET), `app.get("/x", handler)` and friends, and
 *    `pattern("/x", handler, …)` entries of a URL-pattern list. A list
 *    mounted in the same file (`app.addRoute(urlPatterns, "/blog")`) takes
 *    the mount's prefix.
 */
export function extractNimRoutes(lines: string[], callPatterns: CallPattern[]): RouteInfo[] {
  return [...jesterRoutes(lines, callPatterns), ...prologueRoutes(lines)].sort((a, b) => a.line - b.line);
}

// ─── Jester ───────────────────────────────────────────────────────────────

const JESTER_BLOCK = /^(\s*)(?:routes|router\s+([A-Za-z_]\w*))\s*:\s*(?:#.*)?$/;
const JESTER_ROUTE = /^\s*(get|post|put|patch|delete|head|options|any)\s+(re)?"([^"]*)"\s*(?:,\s*([^:]*?))?\s*:\s*(.*)$/;
const JESTER_EXTEND = /^\s*extend\s+([A-Za-z_]\w*)\s*,\s*"([^"]*)"/;

function jesterRoutes(lines: string[], callPatterns: CallPattern[]): RouteInfo[] {
  const routers = new Map<string, RouteInfo[]>();
  const mounted = new Set<string>();
  const top: RouteInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const block = JESTER_BLOCK.exec(lines[i]!);
    if (!block) continue;
    const end = nimBlockEnd(lines, i);
    const routes: RouteInfo[] = [];
    const extended: Array<[string, string]> = [];
    for (let j = i + 1; j < end; j++) {
      const ext = JESTER_EXTEND.exec(lines[j]!);
      if (ext) {
        extended.push([ext[1]!, ext[2]!]);
        continue;
      }
      const m = JESTER_ROUTE.exec(lines[j]!);
      if (!m) continue;
      const bodyEnd = nimBlockEnd(lines, j);
      const inline = m[5]!.replace(/#.*$/, "").trim();
      const calls = extractCallsFromBody(
        lines,
        j + 1,
        bodyEnd,
        ["#"],
        callPatterns,
        inline ? { line: j, column: lines[j]!.length - m[5]!.length } : undefined,
      );
      const method = m[1]!.toUpperCase();
      routes.push({
        path: m[2] ? m[3]! : jesterPath(m[3]!),
        httpMethod: method === "ANY" ? null : method,
        kind: "api",
        handler: null,
        calls,
        middleware: [],
        line: j + 1,
      });
      j = Math.max(j, bodyEnd - 1);
    }
    for (const [name, prefix] of extended) {
      const target = routers.get(name);
      if (!target) continue;
      mounted.add(name);
      for (const r of target) routes.push({ ...r, path: joinPath(prefix, r.path) });
    }
    if (block[2]) routers.set(block[2], routes);
    else top.push(...routes);
    i = Math.max(i, end - 1);
  }
  // A named router nothing in this file extends is still served — `extend`ed
  // from another file, or wired in by hand — at its own paths.
  for (const [name, routes] of routers) if (!mounted.has(name)) top.push(...routes);
  return top;
}

/** `/users/@id/@page?` → `/users/{id}/{page}`. */
function jesterPath(raw: string): string {
  return raw.replace(/@([A-Za-z_]\w*)\??/g, "{$1}");
}

// ─── Prologue ─────────────────────────────────────────────────────────────

/** `app.addRoute(` / bare `addRoute(` / `pattern(` — the arguments follow. */
const PROLOGUE_CALL = /\b(?:addRoute|pattern)\s*\(/g;
/** `app.get("/x", h)` — only with a path literal and a handler name. */
const PROLOGUE_VERB = /\b[A-Za-z_]\w*\.(get|post|put|patch|delete|head|options|all)\s*\(\s*"(\/[^"]*)"\s*,\s*([A-Za-z_][\w.]*)\s*[,)]/g;
/** `app.addRoute(blogPatterns, "/blog")` — a URL-pattern list mounted under a prefix. */
const PROLOGUE_MOUNT = /\baddRoute\s*\(\s*(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)\s*,\s*"([^"]*)"\s*\)/g;
/** `blogPatterns* = @[` — the list a `pattern(…)` entry belongs to. */
const PATTERN_LIST = /^\s*(?:(?:let|var|const)\s+)?([A-Za-z_]\w*)\s*\*?\s*(?::[^=]*)?=\s*@\[/;

function prologueRoutes(lines: string[]): RouteInfo[] {
  // `pattern(…)` and `x.get("/…", h)` name other things elsewhere: only a
  // file that imports Prologue registers routes with them.
  if (!lines.some((l) => /^\s*(?:import|from|include)\b.*\bprologue\b/.test(l))) return [];
  // Which list each line sits in, and where each list is mounted.
  const listOf = new Map<number, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = PATTERN_LIST.exec(lines[i]!);
    if (!m) continue;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      listOf.set(j, m[1]!);
      for (const ch of lines[j]!.replace(/"(?:[^"\\]|\\.)*"/g, "")) depth += ch === "[" ? 1 : ch === "]" ? -1 : 0;
      if (depth <= 0) break;
    }
  }
  const mounts = new Map<string, string[]>();
  for (const line of lines) {
    for (const m of line.matchAll(PROLOGUE_MOUNT)) {
      (mounts.get(m[1]!) ?? mounts.set(m[1]!, []).get(m[1]!)!).push(m[2]!);
    }
  }

  const routes: RouteInfo[] = [];
  const push = (method: string | null, path: string, qualified: string, line: number, middleware: string[]) => {
    // `views.login` names a proc of the imported `views` module, not a class
    // member: the handler is the proc.
    const handler = qualified.slice(qualified.lastIndexOf(".") + 1);
    const list = listOf.get(line - 1);
    const prefixes = list && mounts.has(list) ? mounts.get(list)! : [""];
    for (const prefix of prefixes) {
      routes.push({ path: joinPath(prefix, path), httpMethod: method, kind: "api", handler, calls: [], middleware, line });
    }
  };
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    for (const m of line.matchAll(PROLOGUE_CALL)) {
      // `("/x", handler, @[HttpGet, HttpPost], middlewares = @[auth()], name = "x")`
      const [pathArg, handlerArg, ...more] = splitTopLevel(callArguments(lines, i, m.index! + m[0].length));
      const path = /^\s*(?:re)?"([^"]*)"\s*$/.exec(pathArg ?? "")?.[1];
      const handler = /^\s*([A-Za-z_][\w.]*)\s*$/.exec(handlerArg ?? "")?.[1];
      if (path === undefined || !handler) continue;
      const rest = more.join(",");
      const methods = [...rest.matchAll(/\bHttp(Get|Post|Put|Patch|Delete|Head|Options|Trace|Connect)\b/g)].map((h) => h[1]!.toUpperCase());
      const middleware = [...(/middlewares\s*=\s*@\[(.*)\]/s.exec(rest)?.[1] ?? "").matchAll(/([A-Za-z_]\w*)\s*\(/g)].map((x) => x[1]!);
      for (const method of methods.length > 0 ? methods : ["GET"]) push(method, path, handler, i + 1, middleware);
    }
    for (const m of line.matchAll(PROLOGUE_VERB)) {
      push(m[1] === "all" ? null : m[1]!.toUpperCase(), m[2]!, m[3]!, i + 1, []);
    }
  });
  return routes;
}

/** The argument text of a call whose `(` ends just before `from` on line `i`, up to its balanced `)` (wrapped calls joined). */
function callArguments(lines: string[], i: number, from: number): string {
  let text = "";
  let depth = 1;
  for (let li = i; li < Math.min(lines.length, i + 8); li++) {
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
      if (ch === "(" || ch === "[") depth++;
      else if ((ch === ")" || ch === "]") && --depth === 0) return text;
      text += ch;
    }
    text += " ";
  }
  return text;
}

function joinPath(prefix: string, path: string): string {
  if (!prefix || prefix === "/") return path || "/";
  const joined = prefix.replace(/\/+$/, "") + (path === "/" ? "" : path.startsWith("/") ? path : `/${path}`);
  return joined || "/";
}
