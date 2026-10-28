import type { ClassInfo, FileAnalysis, RouteFact, RouteInfo, RouteParamInfo } from "../../../types/analysis.js";
import type { RouteResolver } from "../../route-resolvers/base.js";
import type { GuardAttr } from "../../shared/route-metadata.js";
import { applyRouteMeta, inferredParam, withInheritedGuards } from "../../shared/route-metadata.js";
import { rubyBodyEnd, rubyCodeLinesOf } from "./blocks.js";
import { enclosingModules } from "./index.js";
import { extractRubyRequestAccess, guardsInBody, paramsFromAccess } from "./route-meta.js";

/**
 * Grape APIs: `class Clubs < Grape::API` declares its endpoints as blocks
 * nested in path scopes —
 *
 *   prefix :api
 *   version 'v1', using: :path
 *   resource :clubs do
 *     route_param :id do
 *       get do
 *         Club.find(params[:id])
 *       end
 *
 * — which Grape serves at `GET /api/v1/clubs/:id`: mount path, prefix, a path
 * version, the namespaces, then the endpoint's own path. The block is the
 * handler, so its calls are the route's (route → table needs no join). A
 * `params do … end` block declares the next endpoint's parameters, and
 * `before do … end` / `http_basic` guard every endpoint after them in the scope.
 *
 * Mounting is cross-file: `mount V1::Clubs` in a root API puts the mounted
 * API's endpoints under the root's mount path, namespace, and — unless the
 * mounted API sets its own — prefix and version; Rails' `mount API::Root =>
 * '/'` in `config/routes.rb` adds its path in front. Each file states what it
 * sees as `routeFacts` (`grape-api`: a class's own prefix and versions;
 * `grape-mount`; `rack-mount`), and `grapeMounts` composes them.
 */

const GRAPE_CLASS_RE = /^(\s*)class\s+((?:::)?[A-Z][\w:]*)\s*<\s*(?:::)?Grape::API(?:::Instance)?\b/;
const BLOCK_TAIL = String.raw`\bdo\b\s*(?:\|[^|]*\|)?\s*$`;
/** `resource :clubs do`, `namespace 'clubs/:id' do`, `namespace do`, `group :admin, requirements: {…} do`. */
const NAMESPACE_RE = new RegExp(String.raw`^\s*(?:resources?|namespace|group|segment)\b\s*\(?\s*(?::(\w+)|(['"])([^'"]*)\2)?.*?` + BLOCK_TAIL);
/** `route_param :id do`, `route_param :id, type: Integer do`. */
const ROUTE_PARAM_RE = new RegExp(String.raw`^\s*route_param\b\s*\(?\s*:(\w+).*?` + BLOCK_TAIL);
/** `get do`, `get ':id' do`, `post :search do`, `put(':id', requirements: {…}) do`. */
const VERB_RE = new RegExp(String.raw`^\s*(get|post|put|patch|delete|head|options)\b\s*\(?\s*(?::(\w+)|(['"])([^'"]*)\3)?.*?` + BLOCK_TAIL);
/** Blocks that declare no endpoint and whose bodies are not the class's: skipped whole. */
const SKIPPED_BLOCK_RE = new RegExp(String.raw`^\s*(?:helpers|desc|rescue_from|after|after_validation|before_validation|finally|namespace_setting|route_setting|class\s*<<|def\b|class\b|module\b).*?` + BLOCK_TAIL);
const MOUNT_RE = /^\s*mount\s*\(?\s*((?:::)?[A-Z][\w:]*)\s*(?:=>\s*(['"])([^'"]*)\2)?/;
/**
 * `route :any, '*path' do`, `route [:get, :post], 'kits' do`, `route ['GET', 'PUT'] do`:
 * the verbs (a symbol, a string or a list of them) and the path.
 */
const ROUTE_DSL_RE = new RegExp(String.raw`^\s*route\b\s*\(?\s*(\[[^\]]*\]|:\w+|(['"])\w+\2)\s*(?:,\s*(?::(\w+)|(['"])([^'"]*)\4))?.*?` + BLOCK_TAIL);
/** A class subclassing some other constant — a Grape API when that constant is one (`class Clubs < API::Base`). */
const SUBCLASS_RE = /^(\s*)class\s+((?:::)?[A-Z][\w:]*)\s*<\s*(?!(?:::)?Sinatra::)((?:::)?[A-Z][\w:]*)\s*$/;
/** A line only a Grape API body has at its top: the gate for reading a subclass of a project base as one. */
const GRAPE_BODY_RE = /^\s*(?:(?:get|post|put|patch|delete|head|options|route|resources?|namespace|route_param|segment|group)\b.*\bdo\b\s*(?:\|[^|]*\|)?\s*$|mount\s+(?:::)?[A-Z])/;

/** Path segments of a symbol or string scope (`:clubs` → `clubs`, `'clubs/:id'` → `clubs/:id`). */
function joinPath(...parts: Array<string | undefined>): string {
  const segs = parts.flatMap((p) => (p ?? "").split("/")).filter(Boolean);
  return "/" + segs.join("/");
}

/** `'v1'`, `'v1', 'v2'`, `['v1', 'v2']` before the options. */
function versionsOf(args: string): { versions: string[]; inPath: boolean } {
  const head = args.split(/\b\w+:/)[0] ?? "";
  const versions = [...head.matchAll(/['"]([^'"]+)['"]|:(\w+)/g)].map((m) => (m[1] ?? m[2])!);
  const using = /\busing:\s*:?['"]?(\w+)/.exec(args)?.[1];
  return { versions, inPath: !using || using === "path" };
}

/** A `params do … end` block's top-level `requires` / `optional` declarations. */
function declaredParams(code: readonly string[], start: number, end: number): Array<{ name: string; type: string | null }> {
  const out: Array<{ name: string; type: string | null }> = [];
  let indent = -1;
  for (let i = start; i < end; i++) {
    const line = code[i] ?? "";
    if (!line.trim()) continue;
    const at = line.length - line.trimStart().length;
    if (indent < 0) indent = at;
    if (at !== indent) continue;
    const m = /^\s*(?:requires|optional)\s*\(?\s*:(\w+)(?:.*?\btype:\s*([A-Z][\w:]*(?:\[[^\]]*\])?))?/.exec(line);
    if (m) out.push({ name: m[1]!, type: m[2] ?? null });
  }
  return out;
}

/**
 * True when the file declares a Grape API — or a class subclassing another
 * constant whose body reads like one, which `grapeMounts` keeps only when
 * that base turns out to be a Grape API (`class Base < Grape::API` in another file).
 */
export function isGrapeFile(lines: readonly string[]): boolean {
  return lines.some((l) => GRAPE_CLASS_RE.test(l)) || (lines.some((l) => SUBCLASS_RE.test(l)) && lines.some((l) => GRAPE_BODY_RE.test(l)));
}

/** The verbs a `route` DSL call names (`:any` → every verb, `null`). */
function routeVerbs(written: string): Array<string | null> {
  const names = [...written.matchAll(/:(\w+)|['"](\w+)['"]/g)].map((m) => (m[1] ?? m[2])!.toUpperCase());
  if (names.includes("ANY")) return [null];
  return names.filter((n) => /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(n));
}

interface Scope {
  /** 0-based index of the scope's `end`. */
  end: number;
  seg: string;
  guards: GuardAttr[];
}

/**
 * The endpoints of every Grape API class in the file, at the path the class
 * serves them under on its own (its prefix and path version, no mount), with
 * `owner` the class's qualified name. `callsOf` reads a block's calls (0-based
 * range, end exclusive). Pushes the class's settings and its mounts to `facts`.
 */
export function extractGrapeRoutes(
  lines: string[],
  classes: readonly ClassInfo[],
  callsOf: (start: number, end: number) => RouteInfo["calls"],
  facts?: RouteFact[],
): RouteInfo[] {
  const code = rubyCodeLinesOf(lines);
  const routes: RouteInfo[] = [];
  for (let c = 0; c < lines.length; c++) {
    const direct = GRAPE_CLASS_RE.exec(code[c] ?? "");
    const sub = direct ? null : SUBCLASS_RE.exec(code[c] ?? "");
    if (!direct && !sub) continue;
    const written = (direct ?? sub)![2]!.replace(/^::/, "");
    const cls = classes.find((k) => k.line === c + 1);
    const owner = cls ? [...enclosingModules(cls, classes), written.split("::").pop()!].join("::") : written;
    const classEnd = rubyBodyEnd(lines, c);
    if (sub && (!facts || !code.slice(c + 1, classEnd).some((l) => GRAPE_BODY_RE.test(l)))) continue;
    const own: RouteFact[] = [];
    const found = readGrapeClass(lines, code, c, classEnd, owner, callsOf, own);
    if (direct) {
      routes.push(...found);
      facts?.push(...own);
    } else if (found.length > 0 || own.some((f) => f.kind === "grape-mount")) {
      // `class Clubs < API::Base`: an API only if `API::Base` is one, which another file says.
      const data: GrapeCandidate = { base: sub![3]!, routes: found, facts: own };
      facts!.push({ kind: "grape-candidate", line: c + 1, owner, data });
    }
    c = classEnd;
  }
  return routes;
}

/** A class whose base may be a Grape API: its endpoints and facts, kept until `grapeMounts` knows. */
interface GrapeCandidate {
  base: string;
  routes: RouteInfo[];
  facts: RouteFact[];
}

/** One Grape API class body (lines `c+1 … classEnd`): its endpoints; its settings and mounts go to `facts`. */
function readGrapeClass(
  lines: string[],
  code: readonly string[],
  c: number,
  classEnd: number,
  owner: string,
  callsOf: (start: number, end: number) => RouteInfo["calls"],
  facts: RouteFact[],
): RouteInfo[] {
  const routes: RouteInfo[] = [];
  let prefix: string | undefined;
  let versions: string[] | undefined;
  let pathVersions: string[] | undefined;
  const classGuards: GuardAttr[] = [];
  const scopes: Scope[] = [];
  let pending: Array<{ name: string; type: string | null }> = [];
  const guardsHere = (): GuardAttr[] => [...classGuards, ...scopes.flatMap((s) => s.guards)];
  const addGuards = (gs: GuardAttr[]): void => {
    (scopes.length > 0 ? scopes[scopes.length - 1]!.guards : classGuards).push(...gs);
  };

  for (let i = c + 1; i < classEnd; i++) {
    while (scopes.length > 0 && i >= scopes[scopes.length - 1]!.end) scopes.pop();
    const line = code[i] ?? "";
    const t = line.trim();
    if (!t) continue;
    let m: RegExpExecArray | null;
    if ((m = /^prefix\s*\(?\s*(?::(\w+)|['"]([^'"]*)['"])/.exec(t)) && scopes.length === 0) {
      prefix = (m[1] ?? m[2])!;
      continue;
    }
    if (/^version\b/.test(t) && scopes.length === 0) {
      const v = versionsOf(t.slice("version".length));
      if (v.versions.length > 0) {
        versions = v.versions;
        pathVersions = v.inPath ? v.versions : undefined;
      }
      continue;
    }
    if (/^params\s+do\b/.test(t)) {
      const end = rubyBodyEnd(lines, i);
      pending = declaredParams(code, i + 1, end);
      i = end;
      continue;
    }
    if (/^before\b.*\bdo\b/.test(t)) {
      const end = rubyBodyEnd(lines, i);
      addGuards(guardsInBody(lines.slice(i + 1, end)));
      i = end;
      continue;
    }
    if ((m = /^before\s*\{(.*)\}\s*$/.exec(t))) {
      addGuards(guardsInBody([m[1]!]));
      continue;
    }
    if (/^http_(?:basic|digest)\b/.test(t)) {
      const scheme = /^http_digest/.test(t) ? "digest" : "basic";
      addGuards([{ text: t.startsWith("http_digest") ? "http_digest" : "http_basic", schemes: [scheme], policies: [`http_${scheme}`] }]);
      if (/\bdo\b/.test(t)) i = rubyBodyEnd(lines, i);
      continue;
    }
    if ((m = MOUNT_RE.exec(line))) {
      const at = /\bat:\s*(['"])([^'"]*)\1/.exec(t)?.[2];
      facts.push({
        kind: "grape-mount",
        line: i + 1,
        owner,
        data: { target: m[1]!, ns: joinPath(...scopes.map((s) => s.seg)), path: m[3] ?? at ?? "", guards: guardsHere() },
      });
      continue;
    }
    const verbs = (m = VERB_RE.exec(line)) ? { methods: [m[1]!.toUpperCase()], path: m[2] ?? m[4] }
      : (m = ROUTE_DSL_RE.exec(line)) ? { methods: routeVerbs(m[1]!), path: m[3] ?? m[5] }
      : null;
    if (verbs) {
      const end = rubyBodyEnd(lines, i);
      const rel = joinPath(...scopes.map((s) => s.seg), verbs.path);
      const body = lines.slice(i + 1, end);
      for (const verb of verbs.methods) for (const v of pathVersions ?? [undefined]) {
        const path = joinPath(prefix, v, rel);
        const route: RouteInfo = {
          path,
          httpMethod: verb,
          kind: "api",
          handler: null,
          calls: callsOf(i + 1, end),
          middleware: [],
          line: i + 1,
          owner,
        };
        const fallback = verb === null || verb === "GET" || verb === "DELETE" || verb === "HEAD" ? "query" : "body";
        const declared = pending.map((p) => inferredParam(p.name, p.type, path, fallback));
        const named = new Set(declared.map((p) => p.name));
        const read = paramsFromAccess(extractRubyRequestAccess(body), path).filter((p) => !named.has(p.name));
        applyRouteMeta(route, {
          inheritedGuards: guardsHere(),
          guards: guardsInBody(body),
          params: [...declared, ...read],
          ...(versions ? { versions: v ? [v] : versions } : {}),
        });
        routes.push(route);
      }
      pending = [];
      i = end;
      continue;
    }
    if ((m = ROUTE_PARAM_RE.exec(line))) {
      scopes.push({ end: rubyBodyEnd(lines, i), seg: `:${m[1]}`, guards: [] });
      continue;
    }
    if ((m = NAMESPACE_RE.exec(line))) {
      scopes.push({ end: rubyBodyEnd(lines, i), seg: m[1] ?? m[3] ?? "", guards: [] });
      continue;
    }
    if (SKIPPED_BLOCK_RE.test(line) || /^def\b/.test(t)) {
      i = rubyBodyEnd(lines, i);
      continue;
    }
  }
  facts.push({ kind: "grape-api", line: c + 1, owner, data: { ...(prefix ? { prefix } : {}), ...(pathVersions ? { versions: pathVersions } : {}) } });
  return routes;
}

/** `mount League::API => '/'` / `mount League::API, at: '/api'` in a Rails router: the path a Rack app is served under. */
export function extractRackMounts(lines: readonly string[], facts?: RouteFact[]): void {
  if (!facts || !lines.some((l) => /\.routes\.draw\b/.test(l))) return;
  const code = rubyCodeLinesOf(lines);
  for (let i = 0; i < code.length; i++) {
    const m = MOUNT_RE.exec(code[i] ?? "");
    if (!m) continue;
    const at = /\bat:\s*(['"])([^'"]*)\1/.exec(code[i]!)?.[2];
    facts.push({ kind: "rack-mount", line: i + 1, data: { target: m[1]!, path: m[3] ?? at ?? "/" } });
  }
}

/**
 * A class subclassing a project base (`class Clubs < API::Base`) is a Grape
 * API when that base is one — `class Base < Grape::API`, or a base of a base.
 * Its endpoints and facts, held in a `grape-candidate` fact, join the file's
 * own then; any other subclass (a Sinatra app's, a Rails controller's) is left alone.
 */
function adoptGrapeSubclasses(analyses: FileAnalysis[]): void {
  const pending: Array<{ a: FileAnalysis; owner: string; c: GrapeCandidate }> = [];
  const known = new Set<string>();
  for (const a of analyses) {
    for (const f of a.routeFacts ?? []) {
      if (f.kind === "grape-api" && f.owner) known.add(f.owner);
      else if (f.kind === "grape-candidate" && f.owner) pending.push({ a, owner: f.owner, c: f.data as GrapeCandidate });
    }
  }
  if (pending.length === 0 || known.size === 0) return;
  // Every Ruby class's base as written, by qualified name — an intermediate base may declare nothing at all.
  const bases = new Map<string, string | null>();
  for (const a of analyses) {
    if (a.language !== "ruby") continue;
    for (const cls of a.classes) {
      if (!cls.extends) continue;
      const name = [...enclosingModules(cls, a.classes), cls.name.split("::").pop()!].join("::");
      bases.set(name, bases.has(name) && bases.get(name) !== cls.extends ? null : cls.extends);
    }
  }
  // Ruby's constant lookup for a superclass: the class's enclosing namespaces outwards, then a unique suffix.
  const lookup = (target: string, owner: string): string | null => {
    const has = (n: string): boolean => known.has(n) || !!bases.get(n);
    if (target.startsWith("::")) return has(target.slice(2)) ? target.slice(2) : null;
    const outer = owner.split("::").slice(0, -1);
    for (let k = outer.length; k >= 0; k--) {
      const name = [...outer.slice(0, k), target].join("::");
      if (has(name)) return name;
    }
    const tail = [...new Set([...known, ...bases.keys()])].filter((n) => has(n) && n.endsWith(`::${target}`));
    return tail.length === 1 ? tail[0]! : null;
  };
  const isApi = (base: string, from: string): boolean => {
    const seen = new Set<string>();
    for (let name = lookup(base, from); name && !seen.has(name); ) {
      if (known.has(name)) return true;
      seen.add(name);
      const next = bases.get(name);
      name = next ? lookup(next, name) : null;
    }
    return false;
  };
  for (const { a, owner, c } of pending) {
    if (known.has(owner) || !isApi(c.base, owner)) continue;
    a.routes.push(...c.routes);
    (a.routeFacts ??= []).push(...c.facts);
  }
}

interface ApiFacts {
  file: string;
  prefix?: string;
  versions?: string[];
}
interface MountFact {
  from: string;
  target: string;
  ns: string;
  path: string;
  guards: GuardAttr[];
}
/** The settings an API's body starts under, from the chain that mounts it. */
interface Context {
  mount: string;
  prefix?: string;
  versions?: string[];
  ns: string;
  guards: GuardAttr[];
}

/**
 * Grape endpoints at the path a request reaches them by, through the APIs that
 * mount them (see `extractGrapeRoutes`). An API nothing mounts keeps its own
 * paths; one mounted at several places answers at each. A mount whose target
 * names no API of the project (a gem's) is ignored.
 */
export const grapeMounts: RouteResolver = {
  id: "grape-mounts",
  languages: ["ruby"],
  priority: 40,
  resolve(analyses: FileAnalysis[]): void {
    adoptGrapeSubclasses(analyses);
    const apis = new Map<string, ApiFacts | null>();
    const mounts: MountFact[] = [];
    const rack: Array<{ target: string; path: string }> = [];
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) {
        if (f.kind === "grape-api" && f.owner) {
          const d = f.data as { prefix?: string; versions?: string[] };
          // One name declared twice (an API reopened in another file) — refuse to choose.
          apis.set(f.owner, apis.has(f.owner) ? null : { file: a.filePath, ...d });
        } else if (f.kind === "grape-mount" && f.owner) {
          mounts.push({ from: f.owner, ...(f.data as Omit<MountFact, "from">) });
        } else if (f.kind === "rack-mount") {
          rack.push(f.data as { target: string; path: string });
        }
      }
    }
    if (apis.size === 0 || (mounts.length === 0 && rack.length === 0)) return;

    // Ruby's constant lookup from inside `from`: its own namespace outwards, then the top level.
    const resolveName = (target: string, from: string): string | null => {
      if (target.startsWith("::")) return apis.get(target.slice(2)) ? target.slice(2) : null;
      const outer = from ? from.split("::") : [];
      for (let k = outer.length; k >= 0; k--) {
        const name = [...outer.slice(0, k), target].join("::");
        if (apis.get(name)) return name;
      }
      const tail = [...apis.keys()].filter((n) => apis.get(n) && n.endsWith(`::${target}`));
      return tail.length === 1 ? tail[0]! : null;
    };
    const incoming = new Map<string, Array<MountFact | { rack: string }>>();
    const into = (name: string, m: MountFact | { rack: string }): void => {
      (incoming.get(name) ?? incoming.set(name, []).get(name)!).push(m);
    };
    for (const m of mounts) {
      const name = resolveName(m.target, m.from);
      if (name && name !== m.from) into(name, m);
    }
    for (const r of rack) {
      const name = resolveName(r.target, "");
      if (name) into(name, { rack: r.path });
    }
    if (incoming.size === 0) return;

    const memo = new Map<string, Context[]>();
    const onStack = new Set<string>();
    const contexts = (name: string): Context[] => {
      const cached = memo.get(name);
      if (cached) return cached;
      const ins = incoming.get(name);
      if (!ins || onStack.has(name)) return [{ mount: "", ns: "", guards: [] }];
      onStack.add(name);
      const out: Context[] = [];
      for (const m of ins) {
        if ("rack" in m) {
          out.push({ mount: joinPath(m.rack), ns: "", guards: [] });
          continue;
        }
        const parent = apis.get(m.from);
        for (const pc of contexts(m.from)) {
          out.push({
            mount: joinPath(pc.mount, m.path),
            prefix: parent?.prefix ?? pc.prefix,
            versions: parent?.versions ?? pc.versions,
            ns: joinPath(pc.ns, m.ns),
            guards: [...pc.guards, ...m.guards],
          });
        }
      }
      onStack.delete(name);
      memo.set(name, out);
      return out;
    };

    for (const a of analyses) {
      const owned = new Set((a.routeFacts ?? []).filter((f) => f.kind === "grape-api" && f.owner && incoming.has(f.owner)).map((f) => f.owner!));
      if (owned.size === 0) continue;
      const next: RouteInfo[] = [];
      for (const r of a.routes) {
        const api = r.owner && owned.has(r.owner) ? apis.get(r.owner) : null;
        if (!api || r.kind !== "api") {
          next.push(r);
          continue;
        }
        // The endpoint's path below its own prefix and version.
        const own = (api.versions ?? [undefined]).map((v) => joinPath(api.prefix, v)).find((b) => b === "/" || r.path === b || r.path.startsWith(`${b}/`));
        const rel = own && own !== "/" ? r.path.slice(own.length) || "/" : r.path;
        const ownVersion = api.versions && r.versions?.length === 1 ? r.versions[0] : undefined;
        const seen = new Set<string>();
        for (const ctx of contexts(r.owner!)) {
          const versions = api.versions ?? ctx.versions;
          for (const v of api.versions ? [ownVersion] : versions ?? [undefined]) {
            const path = joinPath(ctx.mount, api.prefix ?? ctx.prefix, v, ctx.ns, rel);
            if (seen.has(path)) continue;
            seen.add(path);
            let row: RouteInfo = { ...r, path, ...(v && !api.versions ? { versions: [v] } : {}) };
            if (ctx.guards.length > 0) row = withInheritedGuards(row, ctx.guards);
            next.push(row);
          }
        }
      }
      a.routes = next;
    }
  },
};
