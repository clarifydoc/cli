/**
 * Extraction paths that ship beside the path they replace, switched by name, so the two can be compared on the
 * same tree (A/B) before either is retired. Each known feature has a default; a setting only deviates from it.
 *
 * `CLARIFYDOC_FEATURES` holds the names, comma- or space-separated; `analyze --feature <names…>` adds to the
 * same variable, which worker threads inherit. A name switches itself and every name under it: `antlr` covers
 * every ANTLR front end, `antlr:go` only Go's; `tree-sitter:swift` is Swift's tree-sitter front end. A name prefixed `-` or `no-` switches one off (`no-antlr`,
 * `antlr,-antlr:lua`); the more specific name wins.
 *
 * The deviations from the defaults are part of the incremental cache's stamp (`extractorStamp` in
 * manifest.ts): a cached file analysis is reused only by a run that reads files the same way.
 */

/** The features this build knows: what each switches, and whether it is on unless switched off. */
export const KNOWN_FEATURES: Readonly<Record<string, { description: string; default: boolean }>> = {
  antlr: {
    description: "Read the functions and calls of Go, Lua and Rust with their ANTLR grammars; a file with a syntax error keeps the regex reading",
    default: true,
  },
  "tree-sitter": {
    description: "Read the functions and calls of Swift and Dart with their tree-sitter grammars; a file with a syntax error keeps the regex reading",
    default: true,
  },
};

const ENV = "CLARIFYDOC_FEATURES";

let parsedFrom: string | undefined;
let on: string[] = [];
let off: string[] = [];

function current(): void {
  const raw = process.env[ENV] ?? "";
  if (raw === parsedFrom) return;
  parsedFrom = raw;
  const names = raw.split(/[\s,]+/).map((n) => n.trim().toLowerCase()).filter(Boolean);
  const negated = (n: string): string | null => (n.startsWith("-") ? n.slice(1) : n.startsWith("no-") ? n.slice(3) : null);
  on = [...new Set(names.filter((n) => negated(n) === null))];
  off = [...new Set(names.map(negated).filter((n): n is string => n !== null))];
}

/** How specific the most specific entry of `list` covering `name` is (`antlr` covers `antlr:go`), or -1. */
function depthCovered(list: readonly string[], name: string): number {
  let best = -1;
  for (const n of list) if (n === name || name.startsWith(`${n}:`)) best = Math.max(best, n.split(":").length);
  return best;
}

/** The default of `name`: that of the known feature it falls under, else off. */
function defaultOf(name: string): boolean {
  return KNOWN_FEATURES[name.split(":")[0]!]?.default ?? false;
}

/** Whether the feature is on: the most specific setting covering it, else its default. */
export function featureEnabled(name: string): boolean {
  current();
  const key = name.toLowerCase();
  const yes = depthCovered(on, key);
  const no = depthCovered(off, key);
  if (yes < 0 && no < 0) return defaultOf(key);
  return yes > no;
}

/** Adds settings for this process and the workers it starts (`analyze --feature`). */
export function enableFeatures(names: readonly string[]): void {
  const existing = (process.env[ENV] ?? "").split(/[\s,]+/).filter(Boolean);
  process.env[ENV] = [...new Set([...existing, ...names])].join(",");
}

/**
 * The settings that change what a run does, as one canonical string — each named feature whose state differs
 * from its default (`-antlr`, `antlr:go`) — empty for a default run: what the cache stamp carries.
 */
export function featureStamp(): string {
  current();
  const named = [...new Set([...Object.keys(KNOWN_FEATURES), ...on, ...off])].sort();
  return named
    .filter((n) => featureEnabled(n) !== defaultOf(n))
    .map((n) => (featureEnabled(n) ? n : `-${n}`))
    .join(",");
}
