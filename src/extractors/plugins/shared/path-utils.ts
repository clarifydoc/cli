/**
 * Path-matching helpers shared by core and the plugins (leaf module — no
 * imports). Home of the "pick the candidate whose path shares the longest
 * prefix with a reference file" tie-break used wherever several same-named
 * artifacts (classes, views) exist across vendored copies or sibling webapps.
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `s` without its trailing slashes (`a/b//` → `a/b`); a char scan, so a long run of slashes costs nothing. */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* / */) end--;
  return end === s.length ? s : s.slice(0, end);
}

/**
 * `s` with every balanced `<…>` group removed, nesting included
 * (`Dictionary<string, List<int>>` → `Dictionary`); an unclosed `<` and
 * everything after it is dropped too.
 */
export function stripAngleGroups(s: string): string {
  if (!s.includes("<")) return s;
  let out = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "<") depth++;
    else if (ch === ">" && depth > 0) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/**
 * A relative module written as dots and a dotted name — Python's
 * `from .graph import x`, `from ..utils.text import y` — as the relative path
 * a resolver can join: `.graph` → `./graph`, `..utils.text` → `../utils/text`,
 * `...` → `../..`. The first dot is the importer's own package, each further
 * dot one package up. Anything already in path form (`./x`, `../x`, `.`,
 * `..`) comes back unchanged; no JS-family specifier has this shape, since a
 * relative path there must continue with `/`. Joined as written, `.graph`
 * named a file literally called `.graph`, and every call through a relative
 * Python import went unresolved.
 */
export function relativeModulePath(spec: string): string {
  const m = /^(\.+)([A-Za-z_][\w.]*)?$/.exec(spec);
  if (!m) return spec;
  const ups = m[1]!.length - 1;
  const prefix = ups === 0 ? "." : Array.from({ length: ups }, () => "..").join("/");
  return m[2] ? `${prefix}/${m[2].replace(/\./g, "/")}` : prefix;
}

/** Extension (lowercase, no dot) → language family, from every manifest's
 *  `family`. Pushed by the registry: this module is a leaf that plugin code
 *  imports, so it cannot import the registry without closing an ESM cycle. */
let EXT_FAMILY: ReadonlyMap<string, string> = new Map();

export function registerExtensionFamilies(families: ReadonlyMap<string, string>): void {
  EXT_FAMILY = families;
}

/** Language family of a file by extension — bare-name import resolution only
 *  trusts candidates in the importer's own family (`uses X` never imports a
 *  .js file; a doc-generator TOC stub must not shadow a Pascal unit). */
export function extensionFamily(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  return EXT_FAMILY.get(path.slice(dot + 1).toLowerCase()) ?? null;
}

/** Character-level common-prefix length of two paths. */
export function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** The candidate whose path shares the longest prefix with `from` (first wins ties). */
export function pickByPathAffinity<T>(
  candidates: readonly T[],
  pathOf: (c: T) => string,
  from: string,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const c of candidates) {
    const score = commonPrefixLength(pathOf(c), from);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

/**
 * Resolve a server-rendered view path (`/account/details`) to the project file
 * whose path ends with it — with its own extension when the view carries none
 * (`…/WEB-INF/views/account/details.jsp`). The view-resolver prefix is config
 * that never appears in the project tree, so only the suffix can match.
 * Several webapps may hold a view of the same name; the candidate sharing the
 * longest path prefix with `fromFile` wins.
 */
export function resolveViewBySuffix(
  spec: string,
  candidates: Iterable<string>,
  fromFile: string,
): string | null {
  const rel = spec.replace(/\\/g, "/").replace(/^\/+/, "");
  // `(\.\w+)+` (not a single `\.\w+`): view files routinely carry compound
  // extensions — `catalog.blade.php`, `page.html.twig` — and the view name
  // never includes them.
  const suffixRe = /\.\w+$/.test(rel)
    ? new RegExp(`(^|/)${escapeRegex(rel)}$`)
    : new RegExp(`(^|/)${escapeRegex(rel)}(\\.\\w+)+$`);
  let best: string | null = null;
  let bestScore = -1;
  for (const f of candidates) {
    if (!suffixRe.test(f.replace(/\\/g, "/"))) continue;
    const score = commonPrefixLength(f, fromFile);
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}
