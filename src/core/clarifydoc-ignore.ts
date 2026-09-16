import { readFileSync, existsSync } from "fs";
import { sep, posix, resolve, dirname } from "path";

/**
 * Full gitignore-semantics ignore-file support for ClarifyDoc.
 *
 * Ported from graphify-7 (detect.py:397-522). Implements:
 *   - .clarifydocignore at the project root and ancestor directories
 *   - Walking up to the nearest project root (VCS dir or `.clarifydoc/`) as a ceiling
 *   - Last-match-wins semantics with `!` negation
 *   - Anchored patterns (`/foo`) vs unanchored (`foo`)
 *   - Inline `#` comments, escape `\#` for literal hash
 *   - Trailing-space trimming unless escaped
 *
 * Hand-rolled fnmatch supports `*`, `**`, `?`, `[abc]` — fast-glob's transitive
 * micromatch is intentionally not used (avoids a fragile peer dep).
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

export interface IgnorePattern {
  /** Absolute path of the directory that contained the .clarifydocignore */
  anchor: string;
  /** Raw pattern as written (still carries leading `!` and `/`) */
  pattern: string;
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
    const parsed = parseIgnoreLine(line);
    if (parsed) out.push({ anchor, pattern: parsed });
  }
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
  const basename = path.split("/").pop() ?? path;

  let ignored = false;

  for (const { anchor, pattern: raw } of patterns) {
    const negated = raw.startsWith("!");
    const stripped = (negated ? raw.slice(1) : raw);
    const anchored = stripped.startsWith("/");
    const p = stripped.replace(/^\/+|\/+$/g, "");
    if (!p) continue;

    let matched = false;

    if (anchored) {
      const relAnchor = relativeBelow(path, toPosix(anchor));
      if (relAnchor !== null) matched = matchesPattern(relAnchor, p, basename);
    } else {
      const rel = relativeBelow(path, rootPosix);
      if (rel !== null) matched = matchesPattern(rel, p, basename);
      if (!matched && toPosix(anchor) !== rootPosix) {
        const relAnchor = relativeBelow(path, toPosix(anchor));
        if (relAnchor !== null) matched = matchesPattern(relAnchor, p, basename);
      }
    }

    if (matched) ignored = !negated;
  }

  return ignored;
}

function matchesPattern(rel: string, pattern: string, basename: string): boolean {
  if (fnmatch(rel, pattern)) return true;
  if (fnmatch(basename, pattern)) return true;

  // Check each prefix of the path so an unanchored pattern like `build` matches
  // both "build" and "src/build/foo.ts".
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (fnmatch(part, pattern)) return true;
    const prefix = parts.slice(0, i + 1).join("/");
    if (fnmatch(prefix, pattern)) return true;
  }
  return false;
}

/** Return path relative to base if path is at or below base; null otherwise. */
function relativeBelow(path: string, base: string): string | null {
  if (path === base) return "";
  if (path.startsWith(base + "/")) return path.slice(base.length + 1);
  return null;
}

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
export function fnmatch(name: string, pattern: string): boolean {
  let re = FNMATCH_CACHE.get(pattern);
  if (!re) {
    re = new RegExp("^" + globToRegex(pattern) + "$");
    FNMATCH_CACHE.set(pattern, re);
  }
  return re.test(name);
}

function globToRegex(pattern: string): string {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches any number of path segments, optionally followed by /
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
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
