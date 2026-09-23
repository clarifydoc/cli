/**
 * The shape of a result with no rows in it.
 *
 * A miss is an answer, not a failure: the model that called the tool is about
 * to do something expensive (grep the repo, guess another name, give up), and
 * the cheapest thing this server can do is say which call would have data. So
 * every empty result reads the same way —
 *
 *   No routes match (path: /orders · method: POST).
 *   The analysis holds 214 routes — methods present: GET 120, POST 61.
 *   Next: clarifydoc_routes without `method` (7 match) · clarifydoc_search query="orders"
 *
 * — miss, denominator, next call. The hints are stateless by design: they come
 * from the arguments of THIS call and the counts already in the loaded summary,
 * never from what the caller asked earlier. A stdio server's "session" is not
 * reliably one agent, so a hint derived from call history would be wrong more
 * often than useful.
 *
 * Only suggest what can be computed: a filter whose removal actually yields
 * rows, a query term that actually has hits, a freshness state actually
 * observed. A wrong next step costs more than no next step.
 */

import { facts, plural } from "./format.js";
import { rankCandidates, splitTokens, type Candidate } from "./search-rank.js";

/** At most two suggestions — more and this becomes the noise it replaces. */
const MAX_NEXT = 2;

/** The standing fallback: the tool that says what exists at all. */
export const STATUS_HINT = "clarifydoc_status — what was mapped, and how stale it is";

export interface Miss {
  /** Line 1: what was looked for, and that nothing matched. */
  headline: string;
  /** Line 2: what the analysis does hold in this dimension — the denominator. */
  holds?: string | (string | undefined | false)[];
  /** Tool calls worth making, most likely first. Capped; empty falls back to status. */
  next: (string | undefined | false)[];
}

/** Render a miss in the standard three-part shape. */
export function noResults({ headline, holds, next }: Miss): string {
  const lines = [headline];
  for (const line of Array.isArray(holds) ? holds : holds ? [holds] : []) {
    if (line) lines.push(line);
  }
  const shown = next.filter((h): h is string => typeof h === "string" && h.trim() !== "").slice(0, MAX_NEXT);
  lines.push(`Next: ${(shown.length ? shown : [STATUS_HINT]).join(" · ")}`);
  return lines.join("\n");
}

/** `No routes match (path: /orders · method: POST).` */
export function missHeadline(what: string, filters: Array<[string, unknown]>): string {
  const rendered = facts(filters);
  return rendered ? `No ${what} match (${rendered}).` : `No ${what} in this analysis.`;
}

export interface DroppableFilter<T> {
  /** How the argument is spelled in the tool schema, e.g. `method`. */
  label: string;
  keep: (row: T) => boolean;
}

/**
 * Which single filter, dropped, would have yielded rows.
 *
 * "Try a looser filter" is advice; "without `method` there are 7" is a fact,
 * and the difference is whether the next call lands. Only meaningful with two
 * or more filters — dropping the only one leaves the whole dimension, which
 * the denominator line already reports.
 */
export function filterToDrop<T>(
  all: readonly T[],
  filters: ReadonlyArray<DroppableFilter<T>>,
): { label: string; count: number } | undefined {
  if (filters.length < 2) return undefined;
  let best: { label: string; count: number } | undefined;
  for (const dropped of filters) {
    let count = 0;
    for (const row of all) {
      if (filters.every((f) => f === dropped || f.keep(row))) count += 1;
    }
    if (count > 0 && (!best || count > best.count)) best = { label: dropped.label, count };
  }
  return best;
}

export interface TermDiagnosis {
  /** The sentence to print. */
  text: string;
  /** The term with the most hits — the one worth searching for on its own. */
  best: string;
}

/**
 * Which query terms would have matched on their own.
 *
 * The naive "drop a term" hint is wrong here, because `clarifydoc_search`
 * already retries loosely — but that retry only counts a term that names a
 * candidate outright (tier 90+), so a query can miss both passes while its
 * terms still have weak-tier hits. Scoring each term alone is the only way to
 * know which one to keep, and it is worth the pass on a path this rare.
 */
export function termDiagnosis(
  candidates: readonly Candidate[],
  query: string,
  { maxTerms = 4 }: { maxTerms?: number } = {},
): TermDiagnosis | undefined {
  const terms = splitTokens(query).slice(0, maxTerms);
  if (terms.length < 2) return undefined;

  const hit: Array<{ term: string; count: number }> = [];
  const dead: string[] = [];
  for (const term of terms) {
    const count = rankCandidates(candidates, term).length;
    if (count > 0) hit.push({ term, count });
    else dead.push(term);
  }
  if (hit.length === 0) return undefined;

  hit.sort((a, b) => b.count - a.count);
  const best = hit[0]!;
  const parts = [
    `\`${best.term}\` alone has ${plural(best.count, "hit")}` +
      hit
        .slice(1)
        .map((h) => `, \`${h.term}\` ${h.count}`)
        .join(""),
  ];
  if (dead.length) {
    parts.push(`${dead.map((t) => `\`${t}\``).join(" and ")} ${dead.length === 1 ? "matches" : "match"} nothing`);
  }
  return { text: `${parts.join("; ")}.`, best: best.term };
}
