import type { DataSourceInfo, FileAnalysis, FunctionInfo, PathArgCall } from "../types/analysis.js";
import type { ClassIndex, ClassRef, ImportIndex, ProjectContext } from "../types/project.js";
import { buildModuleValueLookup } from "./module-values.js";
import { buildImportDirectoryResolver } from "./import-directories.js";
import { importsNameDirectories, pluginFor } from "../extractors/registry.js";

type ApiCall = DataSourceInfo & { filePath: string };

/**
 * The last word on an api-call's URL before the cross-tier linker reads it:
 * what extractors and project passes could not resolve is made explicit.
 *
 * A URL whose LEADING part is a runtime value — `${this.baseUrl}email/all`,
 * `{}{}/bulk_delete/`, `${this.itemRoute(id)}/duplicate` — names an
 * app-relative path behind a base nobody could compute. Left as written, the
 * linker read the base as part of the path: fused into the first segment
 * (`/{}email/all`, which matches nothing) or standing alone as a wildcard
 * segment (`/{}/duplicate`, which matched any `/:slug/duplicate`). Here the base
 * is split off into `baseExpr` and the target keeps only what follows, so the
 * linker can treat the base as what it is — an unknown prefix of any length.
 *
 * A loopback origin (`http://localhost:5000/api/x`, a dev `environment.ts`) is
 * a server on this machine: it is dropped from the target and kept as the
 * call's literal base, so the call-origin pass can tell WHICH server by its
 * port. A host the source leaves as a hole (`http://${IP}:5000`) states no
 * machine at all: it is an unknown base like any other. Any other absolute
 * URL is another service and stays as written. A bare relative path
 * (`session`, `me`, `forgot-password`) is relative to its client's base, which
 * is just as unknown.
 *
 * Language-agnostic: it reads only the `${…}` / `{…}` hole notation every URL
 * fold renders. Mutates the aggregated rows; returns how many it rewrote.
 */
export function finalizeApiTargets(calls: ApiCall[]): number {
  let changed = 0;
  for (const call of calls) {
    if (call.kind !== "api-call" || !call.target) continue;
    if (call.targetAlternatives) {
      call.targetAlternatives = call.targetAlternatives.map((alt) => splitUnknownBase(alt)?.target ?? alt);
    }
    // A method called on a runtime value where the URL would be (a service's
    // `${this.matches}.getDownloadUrl(id)` no helper template resolved): code, not a
    // URL behind a base — split, it read as the path `/.getDownloadUrl(…)`.
    if (isCodeText(call.target)) {
      call.target = null;
      changed++;
      continue;
    }
    const split = splitUnknownBase(call.target);
    if (!split) continue;
    call.target = split.target;
    if (split.baseExpr !== undefined) call.baseExpr = split.baseExpr;
    if (split.origin !== undefined) call.baseRef = { kind: "literal", key: split.origin };
    changed++;
  }
  return changed;
}

/** Leading holes, then a method called on them, with no path in it: the source of a URL, not one. */
function isCodeText(url: string): boolean {
  let s = url.trim();
  const start = s;
  for (let len = leadingHoleLength(s); len > 0; len = leadingHoleLength(s)) s = s.slice(len);
  return s !== start && !s.includes("/") && /^\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(s);
}

/** A server on this machine: a loopback host. */
const LOOPBACK_ORIGIN = /^(?:https?|wss?):\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;
/** A host the source leaves as a hole (`http://${IP}:5000`, a websocket's `//${host}`): some server, not stated which. */
const HOLE_HOST_ORIGIN = /^(?:(?:https?|wss?):)?\/\/[^/]*\$\{[^/]*?(?=\/|$)/i;
const RELATIVE_PATH = /^[A-Za-z0-9_.~-]+(?:[/?#]|$)/;

/**
 * Split an unresolved leading base off a URL. Null when there is nothing to
 * split (an app path already, another host's URL, or nothing but holes).
 * Exported for tests.
 */
export function splitUnknownBase(url: string): { target: string; baseExpr?: string; origin?: string } | null {
  let s = url.trim();
  let base: string | undefined;
  // A server on this machine: the path after it is complete, so no base is
  // unknown — the origin itself is returned for the port it names.
  const origin = LOOPBACK_ORIGIN.exec(s);
  if (origin) s = s.slice(origin[0].length) || "/";
  // An unstated host: the base is unknown, whatever port it carries.
  const holeHost = origin ? null : HOLE_HOST_ORIGIN.exec(s);
  if (holeHost) s = s.slice(holeHost[0].length) || "/";
  let holes = "";
  for (;;) {
    const len = leadingHoleLength(s);
    if (len === 0) break;
    holes += s.slice(0, len);
    s = s.slice(len);
  }
  if (holes) base = stripHole(holes);
  if (holeHost) base = holes ? `${holeHost[0]} + ${base}` : holeHost[0];
  if (!holes && !origin && !holeHost) {
    // `session` on a client with a base: as unknown a base as a hole.
    if (s.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(s) || !RELATIVE_PATH.test(s)) return null;
    base = "";
  }
  if (!s || s.startsWith("?") || s.startsWith("#")) {
    // Only a base and a query: no path to link — leave the URL as written.
    return origin ? { target: "/" + s, origin: origin[0] } : null;
  }
  const target = s.startsWith("/") ? s : "/" + s;
  return {
    target,
    ...(base !== undefined ? { baseExpr: base } : {}),
    ...(origin ? { origin: origin[0] } : {}),
  };
}

/** Length of a `${…}` or `{…}` hole (braces balanced) at the start of `s`, or 0. */
function leadingHoleLength(s: string): number {
  const open = s.startsWith("${") ? 1 : s.startsWith("{") ? 0 : -1;
  if (open === -1) return 0;
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i + 1;
  }
  return 0;
}

/** `${this.baseUrl}${this.endpoint}` → `this.baseUrl + this.endpoint`; `{}` → "". */
function stripHole(holes: string): string {
  const parts: string[] = [];
  let rest = holes;
  for (;;) {
    const len = leadingHoleLength(rest);
    if (len === 0) break;
    const h = rest.slice(0, len);
    const inner = h.startsWith("${") ? h.slice(2, -1) : h.slice(1, -1);
    if (inner) parts.push(inner);
    rest = rest.slice(len);
  }
  return parts.join(" + ");
}

// ─── Request factories ───────────────────────────────────────────────────────

interface FactoryRow {
  row: ApiCall;
  /** Parameter name → its position in the factory's parameter list. */
  params: Map<string, number>;
}

// `${url}`, or PHP's `{$url}`.
const HOLE = /\$\{([A-Za-z_$][\w$]*)\}|\{\$([A-Za-z_]\w*)\}/g;
const VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** The verb a row's name states (`dio.get`, `$client->post`, `GET`), or null. */
const rowVerb = (row: ApiCall): string | null => {
  const leaf = (row.name ?? "").split(/\.|->/).pop()!.replace(/\(.*$/, "").toUpperCase();
  return VERBS.has(leaf) ? leaf : null;
};

/**
 * A request FACTORY builds its request from its parameters, and every call
 * site names the endpoint:
 *
 *     export default function createFetchHandler(section, url) {
 *       … createAjaxRequest({ url: id == null ? url : `${url}/${id}`, data }) …
 *     }
 *     export const fetchStatus = createFetchHandler('system.status', '/system/status');
 *
 * The factory's own api-call carries `${url}` and says nothing; the call site
 * is where the endpoint is. For each call that hands a literal to a function
 * (`FileAnalysis.pathArgCalls`), this resolves the callee — a function of
 * that name in the caller's file, else the file the name is imported from —
 * and, for every api-call of that function whose URL holes are ITS parameters
 * (the innermost enclosing function declaring the name), adds a row at the
 * call site with the literals substituted by position. A callee whose import
 * does not resolve (a bundler source-root path) falls back to the one factory
 * of that name in the project. A hole whose argument
 * is not a literal leaves that row out; a callee resolving to anything but
 * one function adds nothing. A bare call inside a class that no import names
 * (`await Get<T>(uri)` in a client deriving from a base client) resolves up
 * that class's chain, and only there. A call on a receiver whose class the
 * site states (`receiverType`) resolves on that class's chain instead. A site
 * naming a verb (`method`: `request(RequestType.POST, '/x')`) keeps the rows
 * of the wrapper's branch for that verb, or applies it to a row that names
 * none (`$client->request($verb, $url)`). One level deep: a factory calling a
 * factory is not followed.
 *
 * Returns the number of rows added (appended to `calls`).
 */
export function expandRequestFactories(
  calls: ApiCall[],
  analyses: readonly FileAnalysis[],
  importIndex: ImportIndex,
  classes?: ClassIndex,
  /** The package-import resolver the project shares (built from `analyses` alone when absent). */
  sharedImportDirectory?: (source: string, fromFile: string) => string | null,
): number {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  if (!analyses.some((a) => a.pathArgCalls?.length)) return 0;

  const fnsOf = new Map<string, FunctionInfo[]>();
  const functionsIn = (file: string): FunctionInfo[] => {
    let fns = fnsOf.get(file);
    if (!fns) {
      const a = byFile.get(file);
      fns = a ? [...a.functions, ...a.classes.flatMap((c) => c.methods)] : [];
      fnsOf.set(file, fns);
    }
    return fns;
  };
  /** Factory rows per (file, function name): the rows whose URL holes are their function's parameters. */
  const factoriesOf = (rows: readonly ApiCall[]): Map<string, FactoryRow[]> => {
  const factories = new Map<string, FactoryRow[]>();
  for (const row of rows) {
    if (row.kind !== "api-call" || !row.target) continue;
    const holes = new Set<string>();
    for (const url of [row.target, ...(row.targetAlternatives ?? [])]) for (const m of url.matchAll(HOLE)) holes.add((m[1] ?? m[2])!);
    if (holes.size === 0) continue;
    for (const name of holes) {
      // The innermost function enclosing the row that declares this name.
      const owner = functionsIn(row.filePath)
        .filter((f) => f.line <= row.line && row.line <= f.endLine && f.params.some((p) => p.name === name))
        .sort((a, b) => a.endLine - a.line - (b.endLine - b.line))[0];
      if (!owner) continue;
      const key = `${row.filePath}::${owner.name}`;
      const list = factories.get(key) ?? [];
      let entry = list.find((e) => e.row === row);
      if (!entry) {
        entry = { row, params: new Map() };
        list.push(entry);
      }
      entry.params.set(name, owner.params.findIndex((p) => p.name === name));
      factories.set(key, list);
    }
  }
  return factories;
  };
  let factories = factoriesOf(calls);
  if (factories.size === 0) return 0;

  /**
   * A method the caller inherits (`Get<T>(uri)` in a client deriving from a
   * base client): the factory in the nearest class up the chain that has
   * one. `inClass` says whether the call sits in a class at all.
   */
  const inherited = (file: string, line: number): { inClass: boolean; find(callee: string): FactoryRow[] | undefined } => {
    const own = classes?.classesIn(file).filter((r) => r.cls.line <= line && line <= r.cls.endLine).sort((x, y) => y.cls.line - x.cls.line)[0];
    return {
      inClass: own !== undefined,
      find: (callee) => {
        if (!own || !classes) return undefined;
        for (const s of classes.ancestors(own)) {
          const rows = s.ref ? factories.get(`${s.ref.filePath}::${callee}`) : undefined;
          if (rows) return rows;
        }
        return undefined;
      },
    };
  };

  /**
   * `use App\Http\Model\ApiConnection;` names the class of that name a file
   * declaring namespace `App\Http\Model` holds — an import the module index
   * does not resolve to a file.
   */
  const importedClass = (file: string, name: string): ClassRef | null => {
    const src = importIndex.sourceFor(file, name);
    if (!src || !classes) return null;
    const norm = (s: string) => s.replace(/^\\/, "").replace(/\\|::/g, ".");
    const hits = analyses
      .filter((x) => x.declaredNamespace && norm(`${x.declaredNamespace}.${name}`) === norm(src))
      .flatMap((x) => classes.classesIn(x.filePath).filter((r) => r.cls.name === name));
    return hits.length === 1 ? hits[0]! : null;
  };

  const known = new Set(calls.filter((c) => c.kind === "api-call" && c.target).map((c) => `${c.filePath}:${c.line}:${c.target}`));
  let importDirectory: ((source: string, fromFile: string) => string | null) | null = sharedImportDirectory ?? null;
  const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  let added = 0;
  // A factory calling a factory: a site handing on its own function's parameter
  // (`argNames`) makes that function a factory of the next level.
  for (let level = 0; level < 6 && factories.size > 0; level++) {
  const produced: Array<{ row: ApiCall; onward: boolean }> = [];
  for (const a of analyses) {
    for (const site of a.pathArgCalls ?? []) {
      const ownKey = `${a.filePath}::${site.callee}`;
      // `ApiConnection().request(…)`: that class's method (or an inherited one),
      // and only that — a receiver of no project class (`Uri.parse`,
      // `Route::get`) calls no project factory.
      if (site.receiverType) {
        const receiver = classes?.resolve(a.filePath, site.receiverType) ?? importedClass(a.filePath, site.receiverType);
        if (receiver && classes) {
          const chain = [receiver, ...classes.ancestors(receiver).flatMap((s) => (s.ref ? [s.ref] : []))];
          const owner = chain.find((c) => c.cls.methods.some((m) => m.name === site.callee));
          const rows = owner ? factories.get(`${owner.filePath}::${site.callee}`) : undefined;
          if (rows) expandSite(produced, a.filePath, site, rows, known);
        }
        continue;
      }
      // `signedUrlService.fetch(url)`: the method of that object, in its own module or the one it is imported from.
      let objectRows = site.receiver
        ? factories.get(`${importIndex.localFor(a.filePath, site.receiver) ?? a.filePath}::${site.receiver}.${site.callee}`)
        : undefined;
      // `httplib.NewClientRequest(method, url)`: a function of the package directory the import names.
      if (!objectRows && site.receiver && importsNameDirectories(a.language)) {
        const imp = (a.imports ?? []).find((i) => i.specifiers.includes(site.receiver!));
        const dir = imp ? (importDirectory ??= buildImportDirectoryResolver(analyses))(imp.source, a.filePath) : null;
        const hits = dir === null ? [] : [...factories.keys()].filter((k) => k.endsWith(`::${site.callee}`) && dirOf(k.slice(0, k.indexOf("::"))) === dir);
        if (hits.length === 1) objectRows = factories.get(hits[0]!);
      }
      // A site naming its object joins that object's method only, never a same-named function elsewhere.
      if (site.receiver) {
        if (objectRows) expandSite(produced, a.filePath, site, objectRows, known);
        continue;
      }
      const source = importIndex.localFor(a.filePath, site.callee);
      let rows = factories.get(ownKey) ?? (source ? factories.get(`${source}::${site.callee}`) : undefined);
      // A bare call from inside a class, of a name no import brings in, is a
      // method of that class's own chain — never another class's helper.
      const imported = (a.imports ?? []).some((i) => i.specifiers.includes(site.callee));
      const chain = rows || source || imported ? null : inherited(a.filePath, site.line);
      if (chain?.inClass) {
        rows = chain.find(site.callee);
      } else if (!rows && !source && pluginFor(a.language)?.directoryScope) {
        // A function of another file of the caller's own package (Go): that one, or nothing.
        const dir = dirOf(a.filePath);
        const named = [...factories.keys()].filter((k) => k.endsWith(`::${site.callee}`) && dirOf(k.slice(0, k.indexOf("::"))) === dir);
        if (named.length === 1) rows = factories.get(named[0]!);
      }
      // A bare call in a package-scoped language (Go) never reaches another package.
      const packageScoped = pluginFor(a.language)?.directoryScope && importsNameDirectories(a.language);
      if (!rows && !source && !chain?.inClass && !packageScoped) {
        // An import the index cannot resolve — a bundler's source-root path
        // (`'Store/Actions/Creators/createFetchHandler'`): the ONE factory in
        // the project with that name, or nothing.
        const named = [...factories.keys()].filter((k) => k.endsWith(`::${site.callee}`));
        if (named.length === 1) rows = factories.get(named[0]!);
      }
      if (!rows && source) {
        // A default export bound under another name (`import fetchIt from './createFetchHandler'`):
        // the file's default export, if it is a factory.
        // The export records no name, but it sits on the function's own line.
        const def = byFile.get(source)?.exports.find((e) => e.kind === "default");
        const fnName = def ? functionsIn(source).find((f) => f.line === def.line)?.name : undefined;
        if (fnName) rows = factories.get(`${source}::${fnName}`);
      }
      if (rows) expandSite(produced, a.filePath, site, rows, known);
    }
  }
  // A site whose literal itself names its own function's parameter (`fmt.Sprintf("hook/%s", hookName)`
  // handed to the factory) is a request as it stands AND the next level's factory, which its
  // callers' literals fill (`"pre-receive"`).
  const nextLevel: ApiCall[] = [];
  for (const p of produced) {
    if (p.onward) continue;
    const fns = functionsIn(p.row.filePath).filter((f) => f.line <= p.row.line && p.row.line <= f.endLine);
    const names = [...p.row.target!.matchAll(HOLE)].map((m) => (m[1] ?? m[2])!);
    if (names.some((name) => fns.some((f) => f.params.some((x) => x.name === name)))) nextLevel.push(p.row);
  }
  const onward = [...produced.filter((p) => p.onward).map((p) => p.row), ...nextLevel];
  for (const p of produced) {
    if (p.onward) continue;
    calls.push(p.row);
    known.add(`${p.row.filePath}:${p.row.line}:${p.row.target}`);
    added++;
  }
  factories = factoriesOf(onward);
  }
  return added;
}

/** The rows one call site of a factory adds: each factory row with the site's literals in its holes. */
function expandSite(calls: Array<{ row: ApiCall; onward: boolean }>, filePath: string, site: PathArgCall, rows: FactoryRow[], known: ReadonlySet<string>): number {
  let chosen = rows;
  let method: string | null = null;
  if (site.method && VERBS.has(site.method)) {
    // The wrapper's branch for that verb; else the rows whose verb is a parameter.
    const branch = rows.filter((f) => rowVerb(f.row) === site.method);
    const open = rows.filter((f) => rowVerb(f.row) === null);
    if (branch.length > 0 || open.length > 0) {
      chosen = branch.length > 0 ? branch : open;
      method = site.method;
    }
  }
  const seen = new Set<string>();
  let added = 0;
  for (const f of chosen) {
    // A hole handed the caller's own parameter (`argNames`) stays a hole of that name: the row is the next level's factory.
    let onward = false;
    const fill = (url: string): string | null => {
      let ok = true;
      const out = url.replace(HOLE, (whole, js: string | undefined, php: string | undefined) => {
        const i = f.params.get((js ?? php)!);
        if (i === undefined) return whole;
        const arg = site.args[i];
        if (arg === null || arg === undefined) {
          const name = site.argNames?.[i];
          if (name) {
            onward = true;
            return `\${${name}}`;
          }
          ok = false;
          return whole;
        }
        return arg;
      });
      return ok ? out : null;
    };
    const target = fill(f.row.target!);
    if (target === null) continue;
    // Two branches of one verb (`post(url, data: d)` / `post(url)`) are one request.
    if (method && seen.has(target)) continue;
    seen.add(target);
    // A site already read as that request (a configured client pattern) is not a second one.
    if (known.has(`${filePath}:${site.line}:${target}`)) continue;
    const alternatives = (f.row.targetAlternatives ?? []).map(fill).filter((u): u is string => u !== null);
    calls.push({
      row: {
        ...f.row,
        // A row named by its verb is what the route linker reads the method from.
        ...(method ? { name: method } : {}),
        filePath,
        line: site.line,
        target,
        ...(alternatives.length ? { targetAlternatives: alternatives } : {}),
        via: site.callee,
      },
      onward,
    });
    added++;
  }
  return added;
}

// ─── Symbols in URLs ─────────────────────────────────────────────────────────

const ANY_HOLE = /\$\{([^{}]*)\}/g;

/**
 * Fill the holes in api-call URLs that the project states the value of:
 *
 *   - `${this.baseUrl}` — a field the enclosing class, or the nearest class it
 *     extends, gives a value (`ClassInfo.fieldValues`: `baseUrl =
 *     environment.apiUrl`, a constructor's `this.resourceName = 'tags'`);
 *   - `${environment.apiUrl}`, `${config.PREFIX}` — a module-level value
 *     (`FileAnalysis.moduleValues`) of the file the name is IMPORTED from,
 *     or of the call's own file.
 *
 * A value may itself hold holes (`baseUrl` → `${environment.apiUrl}`), which
 * resolve in the context of the file and class that declared it, up to four
 * levels. Names are only followed through the class chain and the import
 * index — never looked up project-wide — and a hole nothing explains stays a
 * hole for `finalizeApiTargets`. Kavita's `${this.baseUrl}series/${id}`
 * becomes `http://localhost:5000/api/series/${id}`, then `/api/series/${id}`.
 *
 * Returns the number of rows changed.
 */
export function resolveSymbolicTargets(calls: ApiCall[], analyses: readonly FileAnalysis[], ctx: ProjectContext): number {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  const moduleValue = ctx.moduleValue ?? buildModuleValueLookup(analyses, ctx.importIndex);
  const classAt = (file: string, line: number): ClassRef | null => {
    let best: ClassRef | null = null;
    for (const ref of ctx.classes.classesIn(file)) {
      const { line: start, endLine } = ref.cls;
      if (start <= line && line <= endLine && (!best || start >= best.cls.line)) best = ref;
    }
    return best;
  };

  /** The class chain from `self` up, each with the class directly below it (the one whose `super(…)` reached it). */
  const chainOf = (self: ClassRef): Array<{ c: ClassRef; below: ClassRef | null }> => {
    const up = [self, ...ctx.classes.ancestors(self).flatMap((s) => (s.ref ? [s.ref] : []))];
    return up.map((c, i) => ({ c, below: i > 0 ? up[i - 1]! : null }));
  };
  const CTOR = new Set(["constructor", "__init__", "__construct", "init", "new"]);

  /**
   * `this.x` seen from `self`: a field value along the chain — a base field set
   * from a constructor parameter (`this.resource = resource`) holds what the
   * subclass below passed to `super(…)`. Getters read as `this.url` are the
   * URL-builder pass's (url-builders.ts), which runs first.
   */
  const ctorParamIndex = (c: ClassRef, value: string): number => {
    const param = /^\$\{([\w$]+)\}$/.exec(value)?.[1];
    const ctor = param ? c.cls.methods.find((m) => CTOR.has(m.name) || m.name === c.cls.name) : undefined;
    return ctor ? ctor.params.findIndex((p) => p.name === param) : -1;
  };

  /** Does `target`, seen from `self`, still read a field only a subclass's `super(…)` would state? */
  const awaitsSubclass = (target: string, self: ClassRef): boolean => {
    for (const m of target.matchAll(/\$\{this\.([\w$]+)\}/g)) {
      const owner = chainOf(self).find(({ c }) => c.cls.fieldValues?.[m[1]!] !== undefined)?.c;
      if (owner && ctorParamIndex(owner, owner.cls.fieldValues![m[1]!]!) >= 0) return true;
    }
    return false;
  };

  const resolveMember = (member: string, self: ClassRef, depth: number): string | null => {
    const chain = chainOf(self);
    for (let k = 0; k < chain.length; k++) {
      const { c } = chain[k]!;
      const v = c.cls.fieldValues?.[member];
      if (v === undefined) continue;
      let index = ctorParamIndex(c, v);
      if (index < 0) return resolveValue(v, c.filePath, self, depth + 1);
      // Walk down to the class that states the argument: one that only
      // forwards its own parameter (`super(resource, options)`) passes it on.
      for (let j = k - 1; j >= 0; j--) {
        const below = chain[j]!.c;
        const passed = below.cls.superArgs?.[index];
        if (passed === undefined) return null;
        const next = ctorParamIndex(below, passed);
        if (next < 0) return resolveValue(passed, below.filePath, self, depth + 1);
        index = next;
      }
      return null;
    }
    return null;
  };

  const resolveHole = (expr: string, file: string, cls: ClassRef | null, depth: number): string | null => {
    if (depth > 6) return null;
    // `options.apiVersion || DEFAULT_API_VERSION`: the first side the project states.
    const fallback = /^(.+?)\s*(?:\|\||\?\?)\s*(.+)$/.exec(expr);
    if (fallback) return resolveHole(fallback[1]!.trim(), file, cls, depth) ?? resolveHole(fallback[2]!.trim(), file, cls, depth);
    // `'v1'` — the default a fallback names.
    const literal = /^(['"`])([\w.\-/]*)\1$/.exec(expr);
    if (literal) return literal[2]!;
    const field = /^this\.([\w$]+)$/.exec(expr);
    if (field) return cls ? resolveMember(field[1]!, cls, depth) : null;
    // `options.apiVersion`: a member of a constructor parameter, stated by the
    // object literal the subclass below passed to `super(…)` (walked down like `resolveMember`).
    const paramMember = /^([A-Za-z_$][\w$]*)\.([\w$]+)$/.exec(expr);
    if (paramMember && cls) {
      const chain = chainOf(cls);
      for (let k = 0; k < chain.length; k++) {
        let index = ctorParamIndex(chain[k]!.c, `\${${paramMember[1]}}`);
        if (index < 0) continue;
        for (let j = k - 1; j >= 0; j--) {
          const below = chain[j]!.c;
          const passed = below.cls.superArgs?.[index];
          if (passed === undefined) break;
          const next = ctorParamIndex(below, passed);
          if (next >= 0) { index = next; continue; }
          const v = new RegExp(`[{,]\\s*${paramMember[2]}\\s*:\\s*(['"\`])([\\w.\\-/]*)\\1`).exec(passed)?.[2];
          if (v !== undefined) return v;
          break;
        }
        break;
      }
    }
    const name = /^([A-Za-z_$][\w$]*)((?:\.[\w$]+)*)$/.exec(expr);
    if (!name) return null;
    const hit = moduleValue.locate(file, expr);
    if (hit) return resolveValue(hit.value, hit.file, null, depth + 1);
    // `Settings.apiBasePath`: a field value of the project class the name resolves to.
    const member = /^[A-Za-z_$][\w$]*\.([\w$]+)$/.exec(expr)?.[1];
    const owner = member ? ctx.classes.resolve(file, name[1]!) : null;
    const fv = owner?.cls.fieldValues?.[member!];
    return fv === undefined ? null : resolveValue(fv, owner!.filePath, owner, depth + 1);
  };

  /**
   * `this.m(args)` where, seen from `cls`, `m` is a field holding a URL helper
   * (`itemRoute = routes.adminUsersId`, the helper `(id) => `${prefix}/admin/groups/${id}``)
   * or a method with a URL template: that template with the call's arguments.
   */
  const resolveThisCall = (name: string, argsText: string, cls: ClassRef, depth: number): string | null => {
    for (const { c } of chainOf(cls)) {
      const field = c.cls.fieldValues?.[name];
      let helper: FunctionInfo | undefined;
      let helperFile = c.filePath;
      if (field !== undefined) {
        const ref = /^\$\{([A-Za-z_$][\w$.]*)\}$/.exec(field)?.[1];
        if (!ref) return null;
        const source = ctx.importIndex.localFor(c.filePath, ref.split(".")[0]!) ?? c.filePath;
        helper = byFile.get(source)?.functions.find((f) => f.name === ref && f.urlTemplate);
        helperFile = source;
      } else {
        const m = c.cls.methods.find((x) => x.name === name);
        if (!m) continue;
        helper = m.urlTemplate ? m : undefined;
      }
      if (!helper?.urlTemplate) return null;
      const args = splitArgs(argsText);
      // The base the extractor dropped from the template (`${this.constructor.getCollectionResource()}`), put back.
      let out = (helper.urlTemplateBase ? `\${${helper.urlTemplateBase}}` : "") + helper.urlTemplate;
      helper.params.forEach((p, i) => {
        const a = args[i]?.trim();
        const lit = a ? /^(['"`])([^'"`]*)\1$/.exec(a)?.[2] : undefined;
        out = out.split(`{${p.name}}`).join(lit ?? "{}");
      });
      return resolveValue(out, helperFile, cls, depth + 1);
    }
    return null;
  };

  const resolveValue = (value: string, file: string, cls: ClassRef | null, depth: number): string => {
    let out = value;
    if (cls && depth < 6 && out.includes("this.")) {
      out = out.replace(THIS_CALL, (whole, n1: string | undefined, a1: string | undefined, n2: string | undefined, a2: string | undefined) => {
        const r = resolveThisCall((n1 ?? n2)!, (n1 !== undefined ? a1 : a2) ?? "", cls, depth);
        return r === null ? whole : r;
      });
    }
    return out.replace(ANY_HOLE, (hole, expr: string) => resolveHole(expr.trim(), file, cls, depth) ?? hole);
  };

  /**
   * `new CascadeService("rooms")`: each construction with a string argument,
   * as a class of its own that extends the constructed one and passes those
   * arguments to `super(…)` — which is what the constructor receives.
   */
  let instances: Map<ClassRef, ClassRef[]> | null = null;
  const instancesOf = (cls: ClassRef): ClassRef[] => {
    if (!instances) {
      instances = new Map();
      for (const a of analyses) {
        for (const inst of a.instantiations ?? []) {
          const of = ctx.classes.resolve(a.filePath, inst.className);
          if (!of) continue;
          const label = inst.name ?? `${inst.className}(${inst.args.map((x) => JSON.stringify(x)).join(", ")})`;
          const pseudo: ClassRef = {
            filePath: a.filePath,
            projectId: a.projectId,
            language: a.language,
            cls: { name: label, extends: inst.className, implements: [], decorators: [], methods: [], properties: [], superArgs: inst.args, isExported: false, line: inst.line, endLine: inst.line },
          };
          (instances.get(of) ?? instances.set(of, []).get(of)!).push(pseudo);
        }
      }
    }
    return instances.get(cls) ?? [];
  };

  /**
   * A call in a base class whose URL reads `this` (`axios.get(this.url)` in
   * `ApiClient.get`) requests a different URL for every subclass that inherits
   * the method: one row per concrete subclass that does not override it, each
   * resolved as seen from that subclass — and per instance a string argument
   * configures (`instancesOf`).
   */
  const perSubclass = (call: ApiCall, cls: ClassRef): Array<{ target: string; alternatives?: string[]; subclass: string }> => {
    const method = cls.cls.methods.find((m) => m.line <= call.line && call.line <= m.endLine);
    if (!method || ![call.target!, ...(call.targetAlternatives ?? [])].some((t) => t.includes("${this.") || THIS_METHOD.test(t))) return [];
    const out: Array<{ target: string; alternatives?: string[]; subclass: string }> = [];
    const below = ctx.classes.descendants(cls);
    for (const d of [...below, ...[cls, ...below].flatMap(instancesOf)]) {
      // The method `this.m()` dispatches to from `d`: the first definition up its chain.
      const definer = chainOf(d).find(({ c }) => c.cls.methods.some((m) => m.name === method.name))?.c;
      if (definer !== cls) continue;
      const t = collapseEmptySegments(resolveValue(call.target!, call.filePath, d, 0));
      // An abstract middle class (`CacheEnabledApiClient`) leaves a field its own
      // subclasses state through `super(…)`, or a method they override: it requests nothing itself.
      if (awaitsSubclass(t, d) || t.includes("${this.") || THIS_METHOD.test(t)) continue;
      const alternatives = call.targetAlternatives?.map((a) => collapseEmptySegments(resolveValue(a, call.filePath, d, 0)));
      if (t === call.target && !alternatives?.some((a, i) => a !== call.targetAlternatives![i])) continue;
      // One row per subclass even when two request the same URL: each is its
      // own subclass's request (`DocumentService` and `DocumentNotesService`
      // both under `documents/`), and the trace starts at that subclass.
      out.push({ target: t, ...(alternatives ? { alternatives } : {}), subclass: d.cls.name });
    }
    return out;
  };

  let changed = 0;
  const fanned: ApiCall[] = [];
  for (const call of calls) {
    // A field read as a helper's argument (`route(this.baseRoute, {…})`) is the
    // same hole as `${this.baseRoute}`.
    // (`this.constructor.m()` is the class's static method, not a field.)
    if (call.kind === "api-call" && call.target && /\bthis\.(?!constructor\.)[\w$]+(?![\w$(])/.test(call.target) && !call.target.includes("${this.")) {
      call.target = call.target.replace(/(?<![{\w$.])this\.(?!constructor\.)([\w$]+)(?![\w$(])/g, "${this.$1}");
    }
    if (call.kind !== "api-call" || !call.target || !(call.target.includes("${") || THIS_METHOD.test(call.target))) continue;
    const cls = classAt(call.filePath, call.line);
    const variants = cls ? perSubclass(call, cls) : [];
    if (variants.length > 0) {
      const [first, ...rest] = variants;
      call.target = first!.target;
      if (first!.alternatives) call.targetAlternatives = first!.alternatives;
      call.viaSubclass = first!.subclass;
      for (const v of rest) fanned.push({ ...call, target: v.target, viaSubclass: v.subclass, ...(v.alternatives ? { targetAlternatives: v.alternatives } : {}) });
      changed++;
      continue;
    }
    const target = resolveValue(call.target, call.filePath, cls, 0);
    const alternatives = call.targetAlternatives?.map((alt) => resolveValue(alt, call.filePath, cls, 0));
    if (target === call.target && (alternatives ?? []).every((a, i) => a === call.targetAlternatives![i])) continue;
    call.target = target;
    if (alternatives) call.targetAlternatives = alternatives;
    changed++;
  }
  calls.push(...fanned);
  // A project helper that takes a URL first and states no template of its own
  // (`route(rest, params)` adding a query string through `new URL`): the
  // request goes to that URL.
  const passThrough = passThroughHelpers(analyses);
  if (passThrough.size > 0) {
    for (const call of calls) {
      for (const key of ["target"] as const) {
        const t = call[key];
        const m = t ? /^([A-Za-z_$][\w$]*)\(([\s\S]*)\)$/.exec(t.trim()) : null;
        if (!m || !passThrough.has(m[1]!)) continue;
        const first = splitArgs(m[2]!)[0]?.trim();
        if (first && /^\/|^\$\{|^https?:/.test(first)) { call.target = first; changed++; }
        // A module's URL table handed on (`route(routes.clubsBase, query)`, `route(routes.club(id))`), or a
        // template built on one (`` route(`${routes.club(id)}/players`) ``): what that resolves to.
        else if (first) {
          const candidate = /^`[^`]*`$/.test(first) ? first.slice(1, -1)
            : /^[A-Za-z_$][\w$]*\.[\w$]+(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?$/.test(first) ? `\${${first}}` : null;
          const value = candidate ? resolveValue(candidate, call.filePath, classAt(call.filePath, call.line), 0) : null;
          if (value && /^\/|^https?:/.test(value)) { call.target = value; changed++; }
        }
      }
    }
  }
  return changed;
}

/** A field a subclass states as `''` leaves an empty segment (`/api/v1//${id}`): the request goes to `/api/v1/${id}`. */
function collapseEmptySegments(url: string): string {
  return url.replace(/([^:/])\/{2,}/g, "$1/");
}

/** `this.m(args)` in a URL, bare or as a whole `${…}` hole (args without nested parentheses). */
/** A call of a method `this` dispatches: `this.m(…)`, or the class's static one, `this.constructor.m(…)`. */
const THIS_METHOD = /\bthis\.(?:constructor\.)?[\w$]+\s*\(/;

/** `this.m(…)`, `${this.m(…)}` — and `this.constructor.m(…)`, an instance asking its class's static method. */
const THIS_CALL = /\$\{\s*this\.(?:constructor\.)?([\w$]+)\s*\(([^()]*)\)\s*\}|\bthis\.(?:constructor\.)?([\w$]+)\s*\(([^()]*)\)/g;

/** Top-level comma split of an argument list (brackets and quotes respected). */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) { if (c === "\\") i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.filter((a) => a.trim() !== "");
}

/**
 * Project functions whose first parameter is a URL (`url`, `path`, `rest`,
 * `route`, `endpoint`…) and that state no URL template of their own: a call of
 * one requests what it is given. Unique names only.
 */
function passThroughHelpers(analyses: readonly FileAnalysis[]): Set<string> {
  const seen = new Map<string, boolean>();
  for (const a of analyses) {
    for (const fn of a.functions) {
      if (fn.name.includes(".")) continue;
      const ok = !fn.urlTemplate && /^(?:url|uri|path|pathname|rest|route|endpoint|href|resource)$/i.test(fn.params[0]?.name ?? "");
      seen.set(fn.name, seen.has(fn.name) ? false : ok);
    }
  }
  return new Set([...seen].filter(([, ok]) => ok).map(([n]) => n));
}
