import type { RouteInfo } from "../../../../types/analysis.js";
import { extractGraphqlRoutes } from "../../shared/graphql-sdl.js";

/** A template a schema is written in: `gql\`…\``, `graphql\`…\``, or one marked with a leading `#graphql`. */
const SDL_TEMPLATE_RE = /(?:\b(?:gql|graphql)\s*|=\s*|\(\s*)`(\s*(?:#graphql)?[^`]*)`/g;
const ROOT_TYPE_RE = /\b(?:extend\s+)?type\s+(?:Query|Mutation|Subscription)\b/;

/**
 * A schema written inline in code — Apollo Server's `typeDefs = gql\`type
 * Query { … }\``, graphql-yoga's `typeDefs: /* GraphQL *\/ \`…\`` — read with
 * the same SDL parser as a `.graphql` file: each root field a
 * `POST /graphql/<field>` route, at its line in this file. An operation
 * template (`gql\`query GetUser …\``) declares no root type and yields nothing.
 */
export function extractInlineSdlRoutes(sourceText: string): RouteInfo[] {
  if (!ROOT_TYPE_RE.test(sourceText)) return [];
  const out: RouteInfo[] = [];
  for (const m of sourceText.matchAll(SDL_TEMPLATE_RE)) {
    const body = m[1]!;
    if (!ROOT_TYPE_RE.test(body)) continue;
    const startLine = sourceText.slice(0, m.index! + m[0].indexOf("`") + 1).split("\n").length;
    // Interpolations (`${UserFragment}`) are not SDL: blank them, keeping line breaks.
    const lines = body.replace(/\$\{[^}]*\}/g, (x) => x.replace(/[^\n]/g, " ")).split("\n");
    for (const r of extractGraphqlRoutes(lines)) out.push({ ...r, line: r.line + startLine - 1 });
  }
  return out;
}
