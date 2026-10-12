import type { DataSourceInfo, FileAnalysis, FunctionInfo } from "../types/analysis.js";
import type { ClassRef, ImportIndex, ProjectContext } from "../types/project.js";

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
    const split = splitUnknownBase(call.target);
    if (!split) continue;
    call.target = split.target;
    if (split.baseExpr !== undefined) call.baseExpr = split.baseExpr;
    if (split.origin !== undefined) call.baseRef = { kind: "literal", key: split.origin };
    changed++;
  }
  return changed;
}

/** A server on this machine: a loopback host. */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;
/** A host the source leaves as a hole (`http://${IP}:5000`): some server, not stated which. */
const HOLE_HOST_ORIGIN = /^https?:\/\/[^/]*\$\{[^/]*?(?=\/|$)/i;
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

const HOLE = /\$\{([A-Za-z_$][\w$]*)\}/g;

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
 * one function adds nothing. One level deep: a factory calling a factory is
 * not followed.
 *
 * Returns the number of rows added (appended to `calls`).
 */
export function expandRequestFactories(
  calls: ApiCall[],
  analyses: readonly FileAnalysis[],
  importIndex: ImportIndex,
): number {
  const byFile = new Map<string, FileAnalysis>(analyses.map((a) => [a.filePath, a]));
  if (!analyses.some((a) => a.pathArgCalls?.length)) return 0;

  // Factory rows per (file, function name).
  const factories = new Map<string, FactoryRow[]>();
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
  for (const row of calls) {
    if (row.kind !== "api-call" || !row.target) continue;
    const holes = new Set<string>();
    for (const url of [row.target, ...(row.targetAlternatives ?? [])]) for (const m of url.matchAll(HOLE)) holes.add(m[1]!);
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
  if (factories.size === 0) return 0;

  let added = 0;
  for (const a of analyses) {
    for (const site of a.pathArgCalls ?? []) {
      const ownKey = `${a.filePath}::${site.callee}`;
      const source = importIndex.localFor(a.filePath, site.callee);
      let rows = factories.get(ownKey) ?? (source ? factories.get(`${source}::${site.callee}`) : undefined);
      if (!rows && !source) {
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
      for (const f of rows ?? []) {
        const fill = (url: string): string | null => {
          let ok = true;
          const out = url.replace(HOLE, (whole, name: string) => {
            const i = f.params.get(name);
            if (i === undefined) return whole;
            const arg = site.args[i];
            if (arg === null || arg === undefined) {
              ok = false;
              return whole;
            }
            return arg;
          });
          return ok ? out : null;
        };
        const target = fill(f.row.target!);
        if (target === null) continue;
        const alternatives = (f.row.targetAlternatives ?? []).map(fill).filter((u): u is string => u !== null);
        calls.push({
          ...f.row,
          filePath: a.filePath,
          line: site.line,
          target,
          ...(alternatives.length ? { targetAlternatives: alternatives } : {}),
          via: site.callee,
        });
        added++;
      }
    }
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
    const name = /^([A-Za-z_$][\w$]*)((?:\.[\w$]+)*)$/.exec(expr);
    if (!name) return null;
    const source = ctx.importIndex.localFor(file, name[1]!) ?? file;
    const v = byFile.get(source)?.moduleValues?.[expr];
    return v === undefined ? null : resolveValue(v, source, null, depth + 1);
  };

  const resolveValue = (value: string, file: string, cls: ClassRef | null, depth: number): string =>
    value.replace(ANY_HOLE, (hole, expr: string) => resolveHole(expr.trim(), file, cls, depth) ?? hole);

  /**
   * A call in a base class whose URL reads `this` (`axios.get(this.url)` in
   * `ApiClient.get`) requests a different URL for every subclass that inherits
   * the method: one row per concrete subclass that does not override it, each
   * resolved as seen from that subclass.
   */
  const perSubclass = (call: ApiCall, cls: ClassRef): Array<{ target: string; alternatives?: string[] }> => {
    const method = cls.cls.methods.find((m) => m.line <= call.line && call.line <= m.endLine);
    if (!method || ![call.target!, ...(call.targetAlternatives ?? [])].some((t) => /\$\{this\./.test(t))) return [];
    const out: Array<{ target: string; alternatives?: string[] }> = [];
    for (const d of ctx.classes.descendants(cls)) {
      // The method `this.m()` dispatches to from `d`: the first definition up its chain.
      const definer = chainOf(d).find(({ c }) => c.cls.methods.some((m) => m.name === method.name))?.c;
      if (definer !== cls) continue;
      const t = resolveValue(call.target!, call.filePath, d, 0);
      // An abstract middle class (`CacheEnabledApiClient`) leaves a field its own
      // subclasses state through `super(…)`: it requests nothing itself.
      if (awaitsSubclass(t, d)) continue;
      const alternatives = call.targetAlternatives?.map((a) => resolveValue(a, call.filePath, d, 0));
      if (t === call.target && !alternatives?.some((a, i) => a !== call.targetAlternatives![i])) continue;
      if (out.some((o) => o.target === t)) continue;
      out.push({ target: t, ...(alternatives ? { alternatives } : {}) });
    }
    return out;
  };

  let changed = 0;
  const fanned: ApiCall[] = [];
  for (const call of calls) {
    if (call.kind !== "api-call" || !call.target?.includes("${")) continue;
    const cls = classAt(call.filePath, call.line);
    const variants = cls ? perSubclass(call, cls) : [];
    if (variants.length > 0) {
      const [first, ...rest] = variants;
      call.target = first!.target;
      if (first!.alternatives) call.targetAlternatives = first!.alternatives;
      for (const v of rest) fanned.push({ ...call, target: v.target, ...(v.alternatives ? { targetAlternatives: v.alternatives } : {}) });
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
  return changed;
}
