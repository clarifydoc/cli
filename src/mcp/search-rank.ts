/**
 * Relevance ranking for `clarifydoc_search`.
 *
 * The tool used to be a three-tier `indexOf` printed into six fixed sections,
 * which meant two things an agent feels immediately: a multi-word query matched
 * nothing (the whole string had to appear contiguously), and rank was decided by
 * section order rather than by score — a weak route hit outranked a perfect
 * screen hit because Routes printed first.
 *
 * So matching is token-based and ranking is global. Both the query and every
 * candidate field are split on separators AND camelCase boundaries, so
 * `getUserById` is reachable from `user id`; a candidate must contain every
 * query token to match at all. Whole-field equality after normalization is the
 * top tier, which is what keeps `/tags` resolving to the route named `/tags`
 * rather than to the six files with "tags" somewhere in the path.
 *
 * Which FIELD matched is kept alongside the score, because it is the only honest
 * way to separate two candidates that both match exactly: a query with no slash
 * in it is asking for a name, so a route matching on its URL is weaker evidence
 * than a screen or symbol matching on its name — while the same route matching
 * on its handler name is not.
 *
 * Everything here is pure and free of analysis types — the caller flattens its
 * sources into `Candidate`s and supplies the usefulness prior — so the tiers can
 * be unit-tested without a fixture. They are tuned against hand-labelled
 * queries on real repositories, never against this tool's own output.
 */

import { byOrdinal } from "../core/ordinal.js";

export type SearchKind = "route" | "screen" | "file" | "symbol" | "entity" | "api-call";

/** Which field a score came from. `name` for a route is its URL path. */
export type MatchField = "name" | "aka" | "path";

/** One rankable thing, flattened from whichever summary section produced it. */
export interface Candidate {
  kind: SearchKind;
  /** The identifier a human would search for: symbol name, screen name, route path, file path. */
  name: string;
  /** True when `name` is a URL path rather than an identifier — i.e. for routes. */
  nameIsPath?: boolean;
  /**
   * True for an API route only. A frontend route is a line in a router pointing
   * at a component, so the component is the better answer; an API route IS the
   * endpoint, and nothing else answers for it.
   */
  isEndpoint?: boolean;
  /** Extra text that should match but is not the name: a route handler, an entity column. */
  aka?: string[];
  /** Where it lives; null when the source has no file. */
  path: string | null;
  /** Line within `path`, when known. A locatable row outranks a bare path at equal score. */
  line: number | null;
  /** The rendered output line. */
  text: string;
  /**
   * Usefulness prior for tie-breaks — `blastRadius[].impactScore` of the file,
   * already computed by the analyzer and looked up O(1) through the store index.
   */
  weight: number;
}

export interface RankedCandidate extends Candidate {
  score: number;
  via: MatchField;
}

const CAMEL = /([a-z0-9])([A-Z])/g;
const CAMEL_RUN = /([A-Z]+)([A-Z][a-z])/g;

/**
 * Lowercased tokens, split on every separator AND on camelCase boundaries.
 * `"getUserById"` → `[get, user, by, id]`; `"article.service.ts"` → `[article, service, ts]`;
 * `"/profiles/:username"` → `[profiles, username]`.
 */
export function splitTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .replace(CAMEL_RUN, "$1 $2")
    .replace(CAMEL, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Tokens re-joined, so two spellings of the same name compare equal. */
export function normalize(value: string | null | undefined): string {
  return splitTokens(value).join(" ");
}

/**
 * The last path segment with its extension dropped: `a/b/prisma-client.ts` →
 * `prisma-client`, `a/article.service.ts` → `article.service`. Only the final
 * extension goes: a dotted filename is a name, not a path.
 */
function basename(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}

/** The last segment of a route path: `/articles/:slug/favorite` → `favorite`. */
function lastSegment(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1]! : null;
}

/** Does `haystack` contain every token of `needle`, as whole tokens? */
function hasAllTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  return needle.every((t) => haystack.includes(t));
}

/** Does `haystack` start with `needle`, token for token? */
function startsWithTokens(haystack: readonly string[], needle: readonly string[]): boolean {
  return needle.every((t, i) => haystack[i] === t);
}

export interface QueryShape {
  raw: string;
  lower: string;
  tokens: string[];
  normalized: string;
  /** A query written as a URL path (`/tags`) is asking about a route. */
  pathLike: boolean;
}

export function parseQuery(query: string): QueryShape {
  const tokens = splitTokens(query);
  return {
    raw: query,
    lower: query.toLowerCase(),
    tokens,
    normalized: tokens.join(" "),
    pathLike: query.startsWith("/"),
  };
}

export interface Match {
  score: number;
  via: MatchField;
}

const NO_MATCH: Match = { score: 0, via: "name" };

/**
 * How well one candidate answers the query. `score: 0` = no match.
 *
 * The tiers are ordered by how specific the evidence is: an exact name beats an
 * exact filename, which beats a prefix, which beats "all the words are in there
 * somewhere". A query that tokenizes to nothing (`"/"`, `"::"`) can only be
 * matched as a raw substring — there is nothing else left of it.
 */
export function scoreCandidate(candidate: Candidate, q: QueryShape): Match {
  const substring = (): Match | null => {
    if (candidate.name.toLowerCase().includes(q.lower)) return { score: 10, via: "name" };
    if (candidate.path?.toLowerCase().includes(q.lower)) return { score: 10, via: "path" };
    return null;
  };

  if (q.tokens.length === 0) return substring() ?? NO_MATCH;

  const nameTokens = splitTokens(candidate.name);
  const akaTokens = (candidate.aka ?? []).map((a) => splitTokens(a));
  const pathTokens = candidate.path ? splitTokens(candidate.path) : [];

  // 100 — the name IS the query, however either is spelled.
  if (nameTokens.join(" ") === q.normalized) return { score: 100, via: "name" };
  if (akaTokens.some((t) => t.join(" ") === q.normalized)) return { score: 100, via: "aka" };

  // 100 — a multi-segment endpoint is named by its last segment: `/users/login`
  // IS "the login endpoint". Scored as an alias, not as the path, so the
  // slash-less-query demotion below does not apply to it — unlike `/settings`,
  // whose whole path is its name and which the rule above has already handled.
  if (candidate.nameIsPath) {
    const tail = lastSegment(candidate.name);
    if (tail && normalize(tail) === q.normalized) return { score: 100, via: "aka" };
  }

  // 90 — the query names the file.
  if (candidate.path && normalize(basename(candidate.path)) === q.normalized) {
    return { score: 90, via: "path" };
  }

  // 70 / 50 — every query word is in the name, in order from the start or not.
  if (hasAllTokens(nameTokens, q.tokens)) {
    return { score: startsWithTokens(nameTokens, q.tokens) ? 70 : 50, via: "name" };
  }
  if (akaTokens.some((t) => hasAllTokens(t, q.tokens))) return { score: 50, via: "aka" };

  // 40 — the query names a DIRECTORY the candidate sits in. Much weaker than
  // naming the candidate: everything under `src/prisma/` answers "prisma", and
  // the file actually called `prisma-client` must not be buried under all of it.
  if (candidate.path && candidate.path.split("/").slice(0, -1).some((s) => s && normalize(s) === q.normalized)) {
    return { score: 40, via: "path" };
  }

  // 30 — every query word is somewhere in the name plus the path.
  if (hasAllTokens([...nameTokens, ...pathTokens, candidate.kind], q.tokens)) {
    return { score: 30, via: "path" };
  }

  // 10 — a raw substring the tokenizer could not see (a partial word).
  return substring() ?? NO_MATCH;
}

/**
 * Score every candidate and order them.
 *
 * Tie-breaks, in order: field affinity (below); a row that can be opened at a
 * line beats one that can only be opened; then the usefulness prior; then
 * ordinal, so the output is identical on every machine.
 */
export function rankCandidates(
  candidates: readonly Candidate[],
  query: string,
  { loose = false }: { loose?: boolean } = {},
): RankedCandidate[] {
  const q = parseQuery(query);
  const scored: RankedCandidate[] = [];
  for (const candidate of candidates) {
    const match = loose ? scoreLoose(candidate, q) : scoreCandidate(candidate, q);
    if (match.score > 0) scored.push({ ...candidate, score: match.score, via: match.via });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      affinity(b, q) - affinity(a, q) ||
      locatable(b) - locatable(a) ||
      b.weight - a.weight ||
      byOrdinal(a.text, b.text),
  );
  return scored;
}

/**
 * The last-resort pass, run only when requiring every term found nothing at all.
 *
 * It drops the all-terms rule but raises the bar per term: a single term only
 * counts when it names the candidate outright (tier 90+), so "where is the login
 * endpoint" still finds `login`, while "zzz-not-a-thing-zzz" does not drag in
 * every `NotFoundPage` in the project on the strength of the word "not".
 */
function scoreLoose(candidate: Candidate, q: QueryShape): Match {
  let best = NO_MATCH;
  let hits = 0;
  for (const token of q.tokens) {
    const match = scoreCandidate(candidate, parseQuery(token));
    if (match.score < 90) continue;
    hits += 1;
    if (match.score > best.score) best = match;
  }
  return hits === 0 ? NO_MATCH : { score: best.score + (hits - 1), via: best.via };
}

/**
 * Routes cut both ways at equal score, and which way depends on what matched.
 *
 * A query with no slash in it is asking for a name, so a route that matched on
 * its URL is the weaker answer — the screen actually called `Settings` outranks
 * the line in the router that mentions `/settings`. But an API route that
 * matched on its own name — its handler, or the last segment of its path — is
 * the stronger answer: an endpoint is an entry point, and from it the rest of
 * the chain is reachable, which is not true of the service function it calls.
 * That half is for API routes only; a frontend route's "handler" is the name of
 * the component it renders, and the component itself is the better answer.
 * A slash-shaped query prefers routes outright.
 *
 * Both halves are load-bearing on the search-MRR benchmark: the first is what
 * puts `Settings`, `Editor` and `Comment` at rank 1, the second `login` and
 * `favorite`.
 */
function affinity(candidate: RankedCandidate, q: QueryShape): number {
  if (candidate.kind !== "route") return 0;
  if (q.pathLike || (candidate.isEndpoint && candidate.via === "aka")) return 1;
  return candidate.nameIsPath && candidate.via === "name" ? -1 : 0;
}

function locatable(candidate: Candidate): number {
  return candidate.line && candidate.line > 0 ? 1 : 0;
}
