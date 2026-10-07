import type { DataSourceInfo } from "../types/analysis.js";

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

const LOOPBACK_ORIGIN = /^https?:\/\/(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?=\/|$)/i;
const RELATIVE_PATH = /^[A-Za-z0-9_.~-]+(?:[/?#]|$)/;

/**
 * Split an unresolved leading base off a URL. Null when there is nothing to
 * split (an app path already, another host's URL, or nothing but holes).
 * Exported for tests.
 */
export function splitUnknownBase(url: string): { target: string; baseExpr?: string } | null {
  let s = url.trim();
  let base: string | undefined;
  const origin = LOOPBACK_ORIGIN.exec(s);
  if (origin) {
    s = s.slice(origin[0].length) || "/";
    base = origin[0];
  }
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
    return origin ? { target: "/" + s, baseExpr: base } : null;
  }
  return { target: s.startsWith("/") ? s : "/" + s, baseExpr: base };
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
