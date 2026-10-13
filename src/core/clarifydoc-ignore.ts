import { readFileSync, existsSync } from "fs";
import { sep, posix, resolve, dirname } from "path";

/**
 * Full gitignore-semantics ignore-file support for ClarifyDoc.
 *
 * Ported from graphify-7 (detect.py:397-522). Implements:
 *   - .clarifydocignore at the project root and ancestor directories
 *   - Walking up to the nearest project root (VCS dir or `.clarifydoc/`) as a ceiling
 *   - Last-match-wins semantics with `!` negation. Unlike git, a file CAN be
 *     re-included under an excluded parent (`src/**` then `!src/important.ts`):
 *     for a documentation tool that is the request people actually make.
 *   - Anchored patterns (`/foo`, `foo/bar`) vs unanchored (`foo`), decided when
 *     the pattern is parsed rather than while matching
 *   - Inline `#` comments, escape `\#` for literal hash
 *   - Trailing-space trimming unless escaped
 *
 * Hand-rolled fnmatch supports `*`, `**`, `?`, `[abc]` — the glob engine's
 * matcher is intentionally not used (avoids a fragile peer dep).
 */

/**
 * Directories that mark a project root, used as the ceiling when walking up for
 * ignore files. `.clarifydoc/` counts: it is where ClarifyDoc keeps the analysis
 * and the ignore file itself, so it identifies the project root even in a tree
 * with no VCS directory at all (a Delphi checkout exported from source control,
 * a vendored drop, a worktree). Without it the walk from a SUB-project root
 * stops immediately and the root's ignore file is never inherited.
 */
const ROOT_MARKERS = [".git", ".hg", ".svn", "_darcs", ".fossil", ".clarifydoc"] as const;
const IGNORE_FILENAME = ".clarifydocignore";
/**
 * Ignore file kept with the analysis instead of as a dotfile at the project
 * root: `<root>/.clarifydoc/ignore`. Same gitignore syntax, and its patterns
 * are relative to the PROJECT ROOT (not to `.clarifydoc/`), so
 * `/Library/mORMot-master/*` means what it reads as.
 */
const OUTPUT_DIR = ".clarifydoc";
const OUTPUT_IGNORE_FILENAME = "ignore";

/**
 * A parsed ignore line. Anchoring is decided HERE, when the pattern is read,
 * not rediscovered while matching: gitignore treats `foo/bar` as if it were
 * `/foo/bar`, but must NOT treat `foo` as `/foo`, and that distinction is
 * unrecoverable once the pattern has been reduced to a glob string.
 */
export interface IgnorePattern {
  /** Absolute path of the directory that contained the ignore file */
  anchor: string;
  /** Raw pattern as written (still carries leading `!` and `/`) */
  pattern: string;
  /** `!` prefix: a match re-includes instead of excluding. */
  negated: boolean;
  /**
   * True when the pattern is fixed to `anchor` — it starts with `/`, or it
   * carries a `/` anywhere but at the very end. An anchored pattern matches
   * the anchor-relative path or one of its leading directories, and nothing
   * else: no bare-name fallback, no interior segment.
   */
  anchored: boolean;
  /** Written with a trailing `/`, which marks a directory but does not anchor. */
  dirOnly: boolean;
  /** The glob itself: `!`, the anchoring `/` and any trailing `/` removed. */
  glob: string;
}

/**
 * Read ignore files and return patterns in outer→inner order. Inner patterns
 * win on equal-match via last-match-wins traversal in isIgnored.
 *
 * Two locations, both gitignore syntax:
 *   - `.clarifydocignore` at the scan root and every directory up to the
 *     nearest project root (patterns relative to the file's own directory);
 *   - `.clarifydoc/ignore` in those same directories, kept alongside the
 *     analysis it affects (patterns relative to the directory that holds
 *     `.clarifydoc/`), read second within each directory so it has the
 *     final say.
 */
export function loadIgnorePatterns(root: string): IgnorePattern[] {
  const absRoot = resolve(root);
  const ceiling = findProjectRoot(absRoot) ?? absRoot;

  // Collect directories ceiling → root (outer first).
  const dirs: string[] = [];
  let current = absRoot;
  while (true) {
    dirs.push(current);
    if (current === ceiling) break;
    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }
  dirs.reverse(); // ceiling first, scan root last

  const patterns: IgnorePattern[] = [];
  for (const dir of dirs) {
    const p = toPosix(dir);
    readInto(patterns, posix.join(p, IGNORE_FILENAME), dir);
    // Read second, so within one directory it wins on an equal match.
    readInto(patterns, posix.join(p, OUTPUT_DIR, OUTPUT_IGNORE_FILENAME), dir);
  }
  return patterns;
}

/** Append every pattern in `file` (if it exists), anchored at `anchor`. */
function readInto(out: IgnorePattern[], file: string, anchor: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const cleaned = parseIgnoreLine(line);
    if (!cleaned) continue;
    const parsed = parseIgnorePattern(cleaned, anchor);
    if (parsed) out.push(parsed);
  }
}

/**
 * Split a cleaned line into the record `isIgnored` matches with. Returns null
 * for a line that is nothing but `!` and slashes.
 */
export function parseIgnorePattern(cleaned: string, anchor: string): IgnorePattern | null {
  const negated = cleaned.startsWith("!");
  const body = negated ? cleaned.slice(1) : cleaned;
  const dirOnly = body.endsWith("/");
  // Trailing slashes go first: `Library/` names a directory at any depth, so
  // its one slash must not be mistaken for the interior slash that anchors.
  const trimmed = body.replace(/\/+$/, "");
  const anchored = trimmed.includes("/");
  const glob = trimmed.replace(/^\/+/, "");
  if (!glob) return null;
  return { anchor, pattern: cleaned, negated, anchored, dirOnly, glob };
}

/**
 * Parse a single .clarifydocignore line per the gitignore spec.
 * Returns null for blank lines and full-line comments.
 */
export function parseIgnoreLine(raw: string): string | null {
  let line = raw.replace(/[\r\n]+$/, "");
  line = line.replace(/^\s+/, "");
  if (!line || line.startsWith("#")) return null;
  // Strip inline comments: whitespace + `#` + rest, but only when # is unescaped
  line = line.replace(/\s+#+[^\\].*$/, "");
  // Unescape \# → literal #
  line = line.replace(/\\#/g, "#");
  // Remove unescaped trailing spaces
  line = line.replace(/(?<!\\) +$/, "");
  return line || null;
}

/**
 * Test whether an absolute path is ignored under the given patterns and root.
 * Implements last-match-wins: every pattern is checked in order; the final
 * matching pattern decides. `!` flips a previous match.
 */
export function isIgnored(
  absPath: string,
  root: string,
  patterns: readonly IgnorePattern[],
): boolean {
  if (patterns.length === 0) return false;

  const path = toPosix(absPath);
  const rootPosix = toPosix(resolve(root));

  let ignored = false;
  for (const pattern of patterns) {
    if (matches(path, rootPosix, pattern)) ignored = !pattern.negated;
  }
  return ignored;
}

/**
 * Whether a posix path is covered by one ignore pattern, honouring whether the
 * pattern is anchored to the directory of the ignore file that declared it.
 */
function matches(path: string, rootPosix: string, pattern: IgnorePattern): boolean {
  const anchorPosix = toPosix(pattern.anchor);

  if (pattern.anchored) {
    const rel = relativeBelow(path, anchorPosix);
    return rel !== null && matchesAnchored(rel, pattern.glob);
  }

  // Unanchored: relative to the scan root first, and to the ignore file's own
  // directory as well when a sub-root scan inherited it from above.
  const rel = relativeBelow(path, rootPosix);
  if (rel !== null && matchesUnanchored(rel, pattern.glob)) return true;
  if (anchorPosix === rootPosix) return false;
  const relAnchor = relativeBelow(path, anchorPosix);
  return relAnchor !== null && matchesUnanchored(relAnchor, pattern.glob);
}

/**
 * Anchored: the whole relative path, or one of its leading directories — so
 * `/dist` covers `dist/a.js` but never `src/dist/a.js`.
 */
function matchesAnchored(rel: string, glob: string): boolean {
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    if (fnmatch(parts.slice(0, i + 1).join("/"), glob)) return true;
  }
  return false;
}

/** Unanchored: any single segment, so the name may sit at any depth. */
function matchesUnanchored(rel: string, glob: string): boolean {
  if (fnmatch(rel, glob)) return true; // a `**` glob that spans separators
  return matchesSegment(rel, glob);
}

function matchesSegment(rel: string, glob: string): boolean {
  return rel.split("/").some((part) => fnmatch(part, glob));
}

/**
 * The directories a walk need not enter, as a predicate on absolute paths:
 * those a pattern ignores in a way every path below inherits — an anchored
 * pattern matching the directory or one of its parents, an unanchored one
 * matching one of its names — and that no later `!` pattern could re-include
 * anything from. `isIgnored` drops every file below such a directory anyway;
 * walking it first is pure cost, and one gitignored tree of cloned
 * repositories held 1.1M files. Undefined when no pattern can prune.
 */
export function ignoredDirectories(
  root: string,
  patterns: readonly IgnorePattern[],
): ((absDir: string) => boolean) | undefined {
  let lastNegated = -1;
  patterns.forEach((p, i) => { if (p.negated) lastNegated = i; });
  const final = patterns.slice(lastNegated + 1);
  if (final.length === 0) return undefined;
  const rootPosix = toPosix(resolve(root));
  return (absDir) => {
    const path = toPosix(absDir);
    return final.some((pattern) => coversSubtree(path, rootPosix, pattern));
  };
}

/** `matches`, minus the whole-path `**` match a path below may not repeat. */
function coversSubtree(path: string, rootPosix: string, pattern: IgnorePattern): boolean {
  const anchorPosix = toPosix(pattern.anchor);
  if (pattern.anchored) {
    const rel = relativeBelow(path, anchorPosix);
    return rel !== null && matchesAnchored(rel, pattern.glob);
  }
  const rel = relativeBelow(path, rootPosix);
  if (rel !== null && matchesSegment(rel, pattern.glob)) return true;
  if (anchorPosix === rootPosix) return false;
  const relAnchor = relativeBelow(path, anchorPosix);
  return relAnchor !== null && matchesSegment(relAnchor, pattern.glob);
}

/** Return path relative to base if path is at or below base; null otherwise. */
function relativeBelow(path: string, base: string): string | null {
  if (path === base) return "";
  if (path.startsWith(base + "/")) return path.slice(base.length + 1);
  return null;
}

/**
 * Walk up from `start` to the nearest directory holding a root marker (a
 * VCS directory such as `.git`, or `.clarifydoc`). Stops at the filesystem root or the user's
 * home directory, answering null, so a scan of a stray folder never inherits
 * an ignore file from `~`.
 */
function findProjectRoot(start: string): string | null {
  let current = resolve(start);
  const home = process.env.HOME ?? process.env.USERPROFILE ?? null;
  while (true) {
    for (const marker of ROOT_MARKERS) {
      if (existsSync(posix.join(toPosix(current), marker))) return current;
    }
    const parent = dirname(current);
    if (parent === current) return null;
    if (home && current === resolve(home)) return null;
    current = parent;
  }
}

/** Platform separators → `/`. */
function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Minimal fnmatch supporting `*`, `**`, `?`, `[...]`.
 *   `**`  → any number of path segments (including zero)
 *   `*`   → any chars except `/`
 *   `?`   → exactly one char (not `/`)
 *   `[abc]` / `[!abc]` → character class with optional negation
 *
 * Compiled regexes are cached per pattern so file-discovery's per-file ×
 * per-pattern × per-prefix loop doesn't recompile the same regex thousands
 * of times for a normal repo scan.
 */
const FNMATCH_CACHE = new Map<string, RegExp>();
/**
 * Test one path (or name) against a glob in the dialect documented above.
 *
 * @param name - The posix path or basename to test
 * @param pattern - The glob pattern; its compiled regex is cached
 * @returns Whether the whole of `name` matches
 */
export function fnmatch(name: string, pattern: string): boolean {
  let re = FNMATCH_CACHE.get(pattern);
  if (!re) {
    re = new RegExp("^" + globToRegex(pattern) + "$");
    FNMATCH_CACHE.set(pattern, re);
  }
  return re.test(name);
}

/**
 * Compile one glob (the dialect documented on `fnmatch`) to a regex source,
 * without the `^`/`$` anchors.
 */
function globToRegex(pattern: string): string {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          // `**/` matches zero or more COMPLETE path segments. Compiling it to
          // `.*` (as this did) ignored the separator, so `a/**/b` matched
          // `a/xb` and `**/vendor/**` matched `myvendor/`: the glob silently
          // claimed files the author never named. That dialect is shared by
          // `.clarifydoc/ignore` and the config's layers/exempt/generated
          // globs, so an overmatch there excludes real code from the map.
          re += "(?:[^/]*/)*";
          i++;
        } else {
          // Trailing `/**`, or a `**` with no separator after it: anything,
          // separators included.
          re += ".*";
        }
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        re += "\\[";
        i++;
      } else {
        let cls = pattern.slice(i + 1, close);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls.replace(/\\/g, "\\\\") + "]";
        i = close + 1;
      }
    } else if (/[.+^$()|{}\\]/.test(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return re;
}
