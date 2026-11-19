import type { FileAnalysis, RouteFact } from "../../../../types/analysis.js";
import type { ProjectContext } from "../../../../types/project.js";
import type { RouteResolver } from "../../../route-resolvers/base.js";
import { withInheritedGuards, type GuardAttr } from "../../../shared/route-metadata.js";
import { namesCallerCheck } from "../../shared/guard-words.js";
import { inferAstroRoutes } from "./file-routes.js";

/**
 * Astro's `src/middleware.ts` (or `src/middleware/index.ts`) exports `onRequest`,
 * which runs before every page and endpoint. When that handler checks the caller
 * and turns the request away, every Astro route of the same sub-project is
 * guarded. Per file the extractor emits an `astro-middleware` fact only for a
 * guard; the resolver gives each Astro page/endpoint of that sub-project the
 * guard as an inherited one.
 *
 * A middleware that only rewrites headers or locales is no guard. An `onRequest`
 * in any other file (a Fastify hook, a helper) emits nothing — only Astro's
 * middleware path counts.
 */
export const ASTRO_MIDDLEWARE = "astro-middleware";

interface AstroMiddlewareFact {
  guard: GuardAttr;
}

/** Astro's middleware entry: `src/middleware.ts` or `src/middleware/index.ts`. */
const MIDDLEWARE_FILE = /^src\/middleware(?:\/index)?\.[jt]s$/;

/** What in the file reads who is calling. */
const READS_CALLER =
  /\bcookies\s*\.\s*(?:get|has)\s*\(\s*['"`][^'"`]*(?:session|token|auth|jwt|sid)[^'"`]*['"`]|\blocals\s*\.\s*(?:user|session|auth|token)\b|\bgetToken\s*\(|\bauth\s*\(|\bgetSession\s*\(|\bgetServerSession\s*\(|\bjwtVerify\s*\(|\bverifyJwt\s*\(|\bjwt\.verify\s*\(|\bauth\.getUser\s*\(|headers\s*\.\s*get\s*\(\s*['"`]authorization['"`]/i;

/** What turns a caller away. */
const DENIES =
  /\b(?:context\.)?redirect\s*\(|\bResponse\s*\.\s*redirect\s*\(|\bstatus\s*:\s*40[13]\b|\b(?:new\s+)?Response\s*\([^)]*40[13]|\.protect\s*\(/;

/** Whether the file exports Astro's `onRequest`. */
function exportsOnRequest(text: string): boolean {
  return (
    /\bexport\s+(?:async\s+)?function\s+onRequest\b/.test(text) ||
    /\bexport\s+const\s+onRequest\b/.test(text) ||
    /\bexport\s*\{[^}]*\bonRequest\b/.test(text)
  );
}

/** Names that may be the guard: `sequence(a, b)` args, or `onRequest = requireLogin`. */
function namedChecks(text: string): string[] {
  const out: string[] = [];
  const seq = /\bsequence\s*\(\s*([^)]*)\)/.exec(text);
  if (seq) {
    for (const raw of seq[1]!.split(",")) {
      const s = raw.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(s)) out.push(s);
    }
  }
  const alias = /\bexport\s+const\s+onRequest\s*=\s*([A-Za-z_$][\w$]*)\s*;/.exec(text);
  if (alias) out.push(alias[1]!);
  return out;
}

/** Whether the file's code checks the caller and refuses the request. */
function checksCaller(text: string): boolean {
  if (!exportsOnRequest(text)) return false;
  if (namedChecks(text).some((n) => namesCallerCheck(n))) return true;
  return READS_CALLER.test(text) && DENIES.test(text);
}

/**
 * The `astro-middleware` fact of an Astro `src/middleware` that checks the
 * caller, else nothing.
 */
export function inferAstroMiddlewareFacts(relativePath: string, sourceText: string, frameworkIds: string[]): RouteFact[] {
  if (!frameworkIds.includes("astro")) return [];
  const norm = relativePath.replace(/\\/g, "/");
  if (!MIDDLEWARE_FILE.test(norm) || !checksCaller(sourceText)) return [];
  const data: AstroMiddlewareFact = { guard: { text: "onRequest" } };
  return [{ kind: ASTRO_MIDDLEWARE, line: 1, data }];
}

/** The resolver: gives every Astro route of the middleware's sub-project its guard. */
export const astroMiddlewareGuards: RouteResolver = {
  id: "astro-middleware-guards",
  languages: ["typescript", "javascript"],
  priority: 26,
  resolve(analyses: FileAnalysis[], ctx: ProjectContext): void {
    const guards: Array<{ project: string | undefined; fact: AstroMiddlewareFact }> = [];
    const rootOf = (a: FileAnalysis) => (a.projectId ? (ctx.projectRootOf?.(a.projectId) ?? "") : "").replace(/\/+$/, "");
    const relOf = (a: FileAnalysis, root: string) => (root && a.filePath.startsWith(`${root}/`) ? a.filePath.slice(root.length + 1) : a.filePath);
    for (const a of analyses) {
      for (const f of a.routeFacts ?? []) if (f.kind === ASTRO_MIDDLEWARE) guards.push({ project: a.projectId, fact: f.data as AstroMiddlewareFact });
    }
    if (guards.length === 0) return;
    for (const a of analyses) {
      if (a.routes.length === 0) continue;
      const own = guards.filter((g) => g.project === a.projectId);
      if (own.length === 0) continue;
      const rel = relOf(a, rootOf(a));
      const astro = inferAstroRoutes(rel, a, ["astro"]);
      if (astro.length === 0) continue;
      const paths = new Set(astro.map((r) => r.path));
      a.routes = a.routes.map((r) => (paths.has(r.path) ? withInheritedGuards(r, own.map((g) => g.fact.guard)) : r));
    }
  },
};
