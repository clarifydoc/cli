import type { PropertyInfo } from "../../../types/analysis.js";

/**
 * The request value a binder writes into a tagged field: Echo's `param:"club"`,
 * Gin's `uri:"club"`, Fiber's `params:"club"`, Huma's `path:"club"` (a route
 * parameter) — and Echo's, Fiber's or Huma's `query:"season"` (a query value;
 * `-` opts out).
 */
export function boundFromTags(tags: readonly string[]): PropertyInfo["boundFrom"] | undefined {
  for (const t of tags) {
    const m = /^(param|uri|params|path|query):"([\w-]+)/.exec(t);
    if (m && m[2] !== "-") return { kind: m[1] === "query" ? "query-param" : "route-param", name: m[2]! };
  }
  return undefined;
}

/** A struct member's tags as `key:"value"` strings: `ClubID int64 \`path:"club" doc:"…"\`` → `path:"club"`, `doc:"…"`. */
export function goTags(member: string): string[] {
  const tag = /`([^`]*)`\s*$/.exec(member.trim());
  return tag ? [...tag[1]!.matchAll(/(\w+):"((?:[^"\\]|\\.)*)"/g)].map((t) => `${t[1]}:"${t[2]}"`) : [];
}
