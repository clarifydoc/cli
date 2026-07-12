/**
 * Path-matching helpers shared by core and the plugins (leaf module — no
 * imports). Home of the "pick the candidate whose path shares the longest
 * prefix with a reference file" tie-break used wherever several same-named
 * artifacts (classes, views) exist across vendored copies or sibling webapps.
 */

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
