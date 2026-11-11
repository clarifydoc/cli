import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { withInheritedGuards, type GuardAttr } from "../../../shared/route-metadata.js";
import { namesCallerCheck } from "../../shared/guard-words.js";
import { inferFileBasedRoute } from "./file-routes.js";

/**
 * A Next.js `middleware.ts` (or Next 16's `proxy.ts`) runs before every request
 * its `config.matcher` names, so when it checks the caller and turns the
 * request away, every page and route handler the matcher covers is guarded.
 * Per file the extractor reads the middleware's matchers and whether its code
 * checks the caller (`next-middleware` fact — emitted only for a guard); the
 * resolver gives the matching Next routes of the SAME sub-project the guard as
 * an inherited one.
 *
 * A middleware that only rewrites URLs or sets headers is no guard, and a
 * matcher the reader cannot follow (a variable, a `has`/`missing` condition)
 * guards nothing rather than everything.
 */
export const NEXT_MIDDLEWARE = "next-middleware";

interface NextMiddlewareFact {
  guard: GuardAttr;
  /** The matcher sources; null = no matcher, every route. */
  matchers: string[] | null;
  /** The project-relative folder holding the middleware: `""` or `src`. */
  dir: string;
}

const MIDDLEWARE_FILE = /^(src\/)?(middleware|proxy)\.[jt]s$/;

/** What in the file reads who is calling. */
const READS_CALLER =
  /\bgetToken\s*\(|\bauth\s*\(|\bgetSession\s*\(|\bgetServerSession\s*\(|\bgetIronSession\s*\(|\bjwtVerify\s*\(|\bverifyJwt\s*\(|\bjwt\.verify\s*\(|\bauth\.getUser\s*\(|\bupdateSession\s*\(|cookies\s*\.\s*(?:get|has)\s*\(\s*['"`][^'"`]*(?:session|token|auth|jwt|sid)[^'"`]*['"`]|headers\s*\.\s*get\s*\(\s*['"`]authorization['"`]/i;
/** What turns a caller away. */
const DENIES =
  /NextResponse\s*\.\s*redirect\s*\(|\bredirect\s*\(|\bstatus\s*:\s*40[13]\b|\bResponse\s*\.\s*json\s*\([^)]*40[13]|new\s+(?:Next)?Response\s*\([^)]*40[13]|\.protect\s*\(/;
/** Libraries whose middleware is the check. */
const GUARD_LIBRARY = /next-auth\/middleware|\bwithAuth\s*\(|\bauthMiddleware\s*\(|@clerk\/nextjs[^'"]*['"][\s\S]*\bauth\.protect\b|\bauth\.protect\s*\(|\bexport\s*\{[^}]*\bauth\s+as\s+(?:middleware|proxy)\b|\bexport\s+default\s+auth\s*\(/;

/** The name of the default-exported function (`export default function requireLogin`), the middleware itself. */
function defaultExportName(text: string): string | null {
  return /\bexport\s+default\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? null;
}

/** Whether the file's code checks the caller and refuses the request. */
function checksCaller(text: string): boolean {
  if (GUARD_LIBRARY.test(text)) return true;
  const named = defaultExportName(text);
  if (named && namesCallerCheck(named)) return true;
  return READS_CALLER.test(text) && DENIES.test(text);
}

/** The text of the bracketed or quoted value starting at `from` (after leading space), or null. */
function valueAt(text: string, from: number): string | null {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const open = text[i];
  if (open === "'" || open === '"' || open === "`") {
    const end = text.indexOf(open, i + 1);
    return end < 0 ? null : text.slice(i, end + 1);
  }
  if (open !== "[" && open !== "{") return null;
  let depth = 0;
  let quote: string | null = null;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === "\\") j++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      if (--depth === 0) return text.slice(i, j + 1);
    }
  }
  return null;
}

const STRING = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * The matcher sources of `export const config = { matcher: … }`: `null` when it
 * declares no matcher (every request), `undefined` when it declares one this
 * reader cannot follow, else the path patterns (entries with `has`/`missing`
 * conditions are left out — they apply only sometimes).
 */
export function readMatchers(text: string): string[] | null | undefined {
  const cfg = /\bexport\s+const\s+config\b[^=]*=\s*\{/.exec(text);
  if (!cfg) return null;
  const body = valueAt(text, cfg.index + cfg[0].length - 1);
  if (!body) return undefined;
  const key = /\bmatcher\s*:/.exec(body);
  if (!key) return null;
  const value = valueAt(body, key.index + key[0].length);
  if (value === null) return undefined;
  if (value[0] !== "[" && value[0] !== "{") return [...value.matchAll(STRING)].map((m) => m[2]!).slice(0, 1);
  // An array of strings and `{ source }` objects; a `has`/`missing` object is conditional.
  const out: string[] = [];
  const inner = value.slice(1, -1);
  let depth = 0;
  let start = 0;
  const items: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"' || ch === "`") quote = ch;
    else if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      items.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  items.push(inner.slice(start));
  for (const raw of items) {
    const item = raw.trim();
    if (!item) continue;
    if (item[0] === "{") {
      if (/\b(?:has|missing)\s*:/.test(item)) continue;
      const src = /\bsource\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/.exec(item);
      if (src) out.push(src[2]!);
      else return undefined;
    } else if (/^['"`]/.test(item)) {
      const s = /^(['"`])((?:\\.|(?!\1)[^\\])*)\1$/.exec(item);
      if (s) out.push(s[2]!);
      else return undefined;
    } else return undefined; // a spread or a variable
  }
  return out;
}

/** Index of the `)` closing the group opened at `open`. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** A Next matcher (path-to-regexp: `:name`, `:name*`, `:name+`, `:name?`, `(regex)`) as an anchored regular expression. */
export function matcherRegex(source: string): RegExp | null {
  const SEG = "[^/#?]+?";
  let re = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    let prefix = "";
    let at = i;
    if (ch === "/" && (source[i + 1] === ":" || source[i + 1] === "(")) {
      prefix = "/";
      at = i + 1;
    }
    const c = source[at]!;
    if (c === ":" || (c === "(" && prefix)) {
      let j = at;
      let seg = SEG;
      if (c === ":") {
        const name = /^:[A-Za-z_]\w*/.exec(source.slice(at));
        if (!name) return null;
        j = at + name[0].length;
      }
      if (source[j] === "(") {
        const end = closeParen(source, j);
        if (end < 0) return null;
        seg = source.slice(j + 1, end);
        j = end + 1;
      }
      const mod = /^[*+?]/.exec(source.slice(j))?.[0] ?? "";
      if (mod) j++;
      const one = `(?:${seg})`;
      if (!prefix) re += mod === "" ? one : `${one}${mod}`;
      else if (mod === "*") re += `(?:/${one}(?:/${one})*)?`;
      else if (mod === "+") re += `(?:/${one}(?:/${one})*)`;
      else if (mod === "?") re += `(?:/${one})?`;
      else re += `/${one}`;
      i = j;
    } else if (ch === "(") {
      const end = closeParen(source, i);
      if (end < 0) return null;
      const mod = /^[*+?]/.exec(source.slice(end + 1))?.[0] ?? "";
      re += `(?:${source.slice(i + 1, end)})${mod}`;
      i = end + 1 + mod.length;
    } else if (ch === "\\" && i + 1 < source.length) {
      re += `\\${source[i + 1]}`;
      i += 2;
    } else {
      re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  try {
    return new RegExp(`^${re}/?$`);
  } catch {
    return null;
  }
}

/** The URLs a route path can stand for: a parameter as one segment, a catch-all as one or more, an optional one present or absent. */
function samples(path: string): string[] {
  const full = path.replace(/\/:[\w]+\?/g, "/x").replace(/:\w+/g, "x").replace(/\*/g, "x/y");
  const bare = path.replace(/\/:[\w]+\?/g, "").replace(/\/\*$/, "").replace(/:\w+/g, "x") || "/";
  return [...new Set([full || "/", bare])];
}

/** Whether the matchers (null = all) cover a route path. */
export function matcherCovers(matchers: readonly string[] | null, path: string): boolean {
  if (matchers === null) return true;
  const urls = samples(path);
  return matchers.some((m) => {
    const re = matcherRegex(m);
    return re !== null && urls.some((u) => re.test(u));
  });
}

/**
 * The `next-middleware` fact of a Next `middleware.ts`/`proxy.ts` that checks
 * the caller, else nothing.
 */
export function inferNextMiddlewareFacts(relativePath: string, sourceText: string, frameworkIds: string[]): RouteFact[] {
  if (!frameworkIds.includes("nextjs")) return [];
  const m = MIDDLEWARE_FILE.exec(relativePath.replace(/\\/g, "/"));
  if (!m || !checksCaller(sourceText)) return [];
  const matchers = readMatchers(sourceText);
  if (matchers === undefined) return [];
  const data: NextMiddlewareFact = { guard: { text: relativePath.replace(/\\/g, "/").replace(/^.*\//, "") }, matchers, dir: m[1] ? "src" : "" };
  return [{ kind: NEXT_MIDDLEWARE, line: 1, data }];
}

/** The resolver: gives the covered Next routes of the middleware's own sub-project its guard. */
export const nextMiddlewareGuards: RouteResolver = {
  id: "next-middleware-guards",
  languages: ["typescript", "javascript"],
  priority: 26,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const guards: Array<{ project: string | undefined; root: string; fact: NextMiddlewareFact }> = [];
    const rootOf = (a: FileAnalysis) => (a.projectId ? (ctx.projectRootOf?.(a.projectId) ?? "") : "").replace(/\/+$/, "");
    const relOf = (a: FileAnalysis, root: string) => (root && a.filePath.startsWith(`${root}/`) ? a.filePath.slice(root.length + 1) : a.filePath);
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) if (f.kind === NEXT_MIDDLEWARE) guards.push({ project: a.projectId, root: rootOf(a), fact: f.data as NextMiddlewareFact });
    }
    if (guards.length === 0) return;
    for (const a of analyses) {
      if (a.routes.length === 0) continue;
      const own = guards.filter((g) => g.project === a.projectId);
      if (own.length === 0) continue;
      const rel = relOf(a, rootOf(a));
      const file = inferFileBasedRoute(rel, ["nextjs"]);
      if (!file) continue;
      const under = rel.startsWith("src/");
      a.routes = a.routes.map((r) => {
        if (r.path !== file.path) return r;
        const hit = own.filter((g) => (g.fact.dir === "src" ? under : !under) && matcherCovers(g.fact.matchers, r.path));
        return hit.length > 0 ? withInheritedGuards(r, hit.map((g) => g.fact.guard)) : r;
      });
    }
  },
};
