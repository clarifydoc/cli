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
 * the app's own server, so it is dropped; any other absolute URL is another
 * service and stays as written. A bare relative path (`session`, `me`,
 * `forgot-password`) is relative to its client's base, which is just as
 * unknown.
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
    changed++;
  }
  return changed;
}

/** The app's own server: a loopback host, or a host the source leaves as a hole (`http://${IP}:5000`). */
const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\]|[^/]*\$\{[^/]*)(?::\d+)?(?=\/|$)/i;
const RELATIVE_PATH = /^[A-Za-z0-9_.~-]+(?:[/?#]|$)/;

/**
 * Split an unresolved leading base off a URL. Null when there is nothing to
 * split (an app path already, another host's URL, or nothing but holes).
 * Exported for tests.
 */
export function splitUnknownBase(url: string): { target: string; baseExpr?: string } | null {
  let s = url.trim();
  let base: string | undefined;
  // The app's own server: the path after it is complete, so no base is unknown.
  const origin = LOOPBACK_ORIGIN.exec(s);
  if (origin) s = s.slice(origin[0].length) || "/";
  let holes = "";
  for (;;) {
    const len = leadingHoleLength(s);
    if (len === 0) break;
    holes += s.slice(0, len);
    s = s.slice(len);
  }
  if (holes) base = stripHole(holes);
  if (!holes && !origin) {
    // `session` on a client with a base: as unknown a base as a hole.
    if (s.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(s) || !RELATIVE_PATH.test(s)) return null;
    base = "";
  }
  if (!s || s.startsWith("?") || s.startsWith("#")) {
    // Only a base and a query: no path to link — leave the URL as written.
    return origin ? { target: "/" + s } : null;
  }
  const target = s.startsWith("/") ? s : "/" + s;
  return base === undefined ? { target } : { target, baseExpr: base };
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

  const resolveHole = (expr: string, file: string, cls: ClassRef | null, depth: number): string | null => {
    if (depth > 4) return null;
    // `options.apiVersion || DEFAULT_API_VERSION`: the first side the project states.
    const fallback = /^(.+?)\s*(?:\|\||\?\?)\s*(.+)$/.exec(expr);
    if (fallback) return resolveHole(fallback[1]!.trim(), file, cls, depth) ?? resolveHole(fallback[2]!.trim(), file, cls, depth);
    const field = /^this\.([\w$]+)$/.exec(expr);
    if (field) {
      if (!cls) return null;
      const chain = [cls, ...ctx.classes.ancestors(cls).flatMap((s) => (s.ref ? [s.ref] : []))];
      for (const c of chain) {
        const v = c.cls.fieldValues?.[field[1]!];
        if (v !== undefined) return resolveValue(v, c.filePath, c, depth + 1);
      }
      return null;
    }
    const name = /^([A-Za-z_$][\w$]*)((?:\.[\w$]+)*)$/.exec(expr);
    if (!name) return null;
    const source = ctx.importIndex.localFor(file, name[1]!) ?? file;
    const v = byFile.get(source)?.moduleValues?.[expr];
    return v === undefined ? null : resolveValue(v, source, null, depth + 1);
  };

  const resolveValue = (value: string, file: string, cls: ClassRef | null, depth: number): string =>
    value.replace(ANY_HOLE, (hole, expr: string) => resolveHole(expr.trim(), file, cls, depth) ?? hole);

  let changed = 0;
  for (const call of calls) {
    if (call.kind !== "api-call" || !call.target?.includes("${")) continue;
    const cls = classAt(call.filePath, call.line);
    const target = resolveValue(call.target, call.filePath, cls, 0);
    const alternatives = call.targetAlternatives?.map((alt) => resolveValue(alt, call.filePath, cls, 0));
    if (target === call.target && (alternatives ?? []).every((a, i) => a === call.targetAlternatives![i])) continue;
    call.target = target;
    if (alternatives) call.targetAlternatives = alternatives;
    changed++;
  }
  return changed;
}
