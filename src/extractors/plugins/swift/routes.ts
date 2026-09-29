import type { RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import { applyRouteMeta, inferredParam, pathParamNames, type GuardAttr } from "../../shared/route-metadata.js";
import { splitTopLevel } from "../shared/regex-base.js";
import { extractSwiftRequestAccess } from "./request-schema.js";

/**
 * Vapor (Swift server) routes — Swift produced zero routes before:
 *
 *   app.get("users", ":id") { req in ... }          // trailing-closure handler
 *   app.post("api", "orders", use: OrderController.create)
 *   let api = app.grouped("api")                    // group prefix binding
 *   api.get("todos", use: index)
 *   app.on(.GET, "custom") { ... }
 *
 * A path is spelled as comma-separated string segments (`"users", ":id"` →
 * `/users/:id` — `:param` is already the linker's wildcard form). Group vars
 * bound via `grouped(...)` carry a composed prefix, exactly like gin's Group.
 *
 * `grouped(...)` also takes middleware, and that is where Vapor's auth lives:
 *
 *   let protected = app.grouped(UserToken.authenticator(), User.guardMiddleware())
 *   app.grouped(JWTMiddleware()).get("me") { req in ... }
 *
 * Every non-string argument is a middleware the group's routes inherit; the
 * ones whose name says authenticator / guard / auth / jwt / token / session
 * become the route's `auth` (a scheme when the name spells a mechanism —
 * jwt / basic / bearer / token / session — else a policy).
 *
 * The verb names are generic (`.get(`), so a route requires the receiver to be
 * `app`/`routes`/`router`/`group` or a tracked `grouped(...)` variable —
 * `req.client.get("https://…")` (an OUTBOUND call) and dictionary helpers
 * never qualify.
 */

/** A candidate receiver: an identifier followed by `.` (the chain/verb is read from there). */
const RECEIVER_RE = /(?<![\w.])(\w+)(?=\s*\.)/g;
/** `.verb(` or `.on(.VERB` right after the receiver (or its `grouped` chain). */
const VERB_TAIL_RE = /^\s*\.(?:(get|post|put|patch|delete|head|options)\s*\(|on\s*\(\s*\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS))/;
const USE_RE = /use:\s*([\w.]+)/;
const SEGMENT_RE = /"([^"]*)"/g;
const BINDING_RE = /^\s*(?:let|var)\s+(\w+)\s*=\s*/;

/** Receivers that are route builders even without a tracked `grouped` binding. */
const BUILDER_RECEIVER_RE = /^(app|routes|router|group|builder)$/;

/** A middleware whose name says it authenticates or authorises. */
const AUTH_MIDDLEWARE_RE = /authenticator|guard|auth|jwt|token|session/i;
/** …and one that names a mechanism rather than a check. */
const SCHEME_RE = /jwt|basic|bearer|token|session/i;

interface Group {
  prefix: string;
  /** Plain middleware, kept as text only. */
  middleware: string[];
  guards: GuardAttr[];
}

function segmentsOf(argText: string): string[] {
  return [...argText.matchAll(SEGMENT_RE)].map((m) => m[1]!).filter((s) => s.length > 0);
}

function joinPath(prefix: string, segments: string[]): string {
  const parts = [prefix, ...segments].join("/").split("/").filter(Boolean);
  return "/" + parts.join("/");
}

/** The balanced argument text of the call whose `(` is at `open`, and the index after its `)`. */
function balancedArgs(text: string, open: number): { args: string; end: number } | null {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { args: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** One middleware expression → what it contributes to the route. */
export function middlewareGuard(expr: string): GuardAttr | null {
  const text = expr.replace(/\s+/g, " ").trim();
  if (!AUTH_MIDDLEWARE_RE.test(text)) return null;
  const name = text.replace(/\(.*$/s, "");
  return SCHEME_RE.test(name)
    ? { text, anonymous: false, policies: [], roles: [], schemes: [name] }
    : { text, anonymous: false, policies: [name], roles: [], schemes: [] };
}

/**
 * Walk a `recv.grouped(a).grouped(b)` chain from `text[start]`: the group it
 * denotes (prefix + middleware composed onto `base`) and where the chain ends.
 */
function readGroupChain(text: string, start: number, base: Group): { group: Group; end: number } {
  let group: Group = { prefix: base.prefix, middleware: [...base.middleware], guards: [...base.guards] };
  let pos = start;
  for (;;) {
    const m = text.slice(pos).match(/^\s*\.grouped\s*\(/);
    if (!m) break;
    const open = pos + m[0].length - 1;
    const call = balancedArgs(text, open);
    if (!call) break;
    const segments: string[] = [];
    for (const arg of splitTopLevel(call.args)) {
      const trimmed = arg.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('"')) {
        segments.push(...segmentsOf(trimmed));
        continue;
      }
      const guard = middlewareGuard(trimmed);
      if (guard) group.guards.push(guard);
      else group.middleware.push(trimmed.replace(/\s+/g, " "));
    }
    group = { ...group, prefix: joinPath(group.prefix, segments) };
    pos = call.end;
  }
  return { group, end: pos };
}

/** The closure body that follows a route declaration on `lines[i]`, when it opens one. */
function closureBody(lines: string[], i: number, from: number): string[] {
  const first = lines[i]!;
  const open = first.indexOf("{", from);
  if (open < 0) return [];
  const body: string[] = [];
  let depth = 0;
  for (let li = i; li < lines.length; li++) {
    const line = lines[li]!;
    const startAt = li === i ? open : 0;
    for (let c = startAt; c < line.length; c++) {
      if (line[c] === "{") depth++;
      else if (line[c] === "}") {
        depth--;
        if (depth === 0) {
          body.push(li === i ? line.slice(open + 1, c) : line.slice(0, c));
          return body;
        }
      }
    }
    body.push(li === i ? line.slice(open + 1) : line);
  }
  return body;
}

export function extractVaporRoutes(lines: string[]): RouteInfo[] {
  const routes: RouteInfo[] = [];
  /** group variable → composed prefix + middleware. */
  const groups = new Map<string, Group>();
  const groupOf = (name: string): Group | null =>
    groups.get(name) ?? (BUILDER_RECEIVER_RE.test(name) ? { prefix: "", middleware: [], guards: [] } : null);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;

    // `let g = recv.grouped(...)...` — a named group.
    const binding = line.match(BINDING_RE);
    if (binding) {
      const rest = line.slice(binding[0].length);
      const recv = rest.match(/^(\w+)(?=\s*\.grouped\s*\()/);
      const base = recv ? groupOf(recv[1]!) : null;
      if (recv && base) {
        groups.set(binding[1]!, readGroupChain(rest, recv[1]!.length, base).group);
        continue;
      }
    }

    // `recv[.grouped(...)]*.verb(` / `.on(.VERB,` where recv is a builder.
    let found: { receiver: string; group: Group; ownGuards: GuardAttr[]; ownMiddleware: string[]; method: string; open: number; isOn: boolean } | null = null;
    for (const m of line.matchAll(RECEIVER_RE)) {
      const base = groupOf(m[1]!);
      if (!base) continue;
      const chain = readGroupChain(line, m.index! + m[0].length, base);
      const tail = line.slice(chain.end).match(VERB_TAIL_RE);
      if (!tail) continue;
      found = {
        receiver: m[1]!,
        group: base,
        ownGuards: chain.group.guards.slice(base.guards.length),
        ownMiddleware: chain.group.middleware.slice(base.middleware.length),
        method: (tail[1] ?? tail[2])!.toUpperCase(),
        open: chain.end + tail[0].indexOf("("),
        isOn: tail[2] !== undefined,
      };
      // Prefix segments of an inline chain belong to the route path.
      found.group = { ...base, prefix: chain.group.prefix };
      break;
    }
    if (!found) continue;
    const { receiver, group, ownGuards, ownMiddleware, method, open, isOn } = found;

    const call = balancedArgs(line, open);
    const argText = call ? call.args : line.slice(open + 1);
    const argsOnly = isOn ? argText.replace(/^\s*\.[A-Z]+\s*,?/, "") : argText;
    const segments = segmentsOf(argsOnly);
    const use = argsOnly.match(USE_RE)?.[1] ?? null;
    // A verb with neither path segments nor a `use:` handler on a bare
    // builder name is likely not a route declaration at all.
    if (!isOn && segments.length === 0 && !use && !groups.has(receiver) && ownGuards.length === 0 && ownMiddleware.length === 0) continue;

    const path = joinPath(group.prefix, segments);
    const route: RouteInfo = {
      path,
      httpMethod: method,
      kind: "api",
      handler: use,
      calls: [],
      middleware: [...group.middleware, ...ownMiddleware],
      line: lineNo,
    };
    // A `use:` handler is declared elsewhere — the project-level join reads
    // its signature and body, so the route must not carry `params` of its
    // own. A trailing closure has no such handler: its body is right here.
    let params: RouteParamInfo[] | undefined;
    if (!use) {
      params = [...pathParamNames(path)].map((name) => inferredParam(name, null, path, null));
      const body = closureBody(lines, i, call ? call.end : open);
      const seen = new Set(params.map((p) => `${p.binding}:${p.name}`));
      for (const acc of extractSwiftRequestAccess(body, { name: "", params: [] })) {
        if (seen.has(`${acc.binding}:${acc.name}`)) continue;
        seen.add(`${acc.binding}:${acc.name}`);
        params.push({ ...acc, inferred: true });
      }
    }
    applyRouteMeta(route, { inheritedGuards: group.guards, guards: ownGuards, params });
    routes.push(route);
  }

  return routes;
}
