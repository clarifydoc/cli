/**
 * Every walk over an analyzed tree goes through here, never through the glob
 * library directly, so two rules hold for all of them:
 *
 * - **Symbolic links are never followed.** A followed link lets a scanned
 *   repository read outside itself (`src/leak.py -> /etc/passwd`, a linked
 *   directory) and turns one self-referencing link (`src/loop -> ..`) into
 *   every file repeated at each of ~32 nesting levels until the OS refuses the
 *   path — exponentially more with two such links. A repository analyzed
 *   after cloning it from a URL is controlled by whoever controls that URL,
 *   so both are reachable by them. A walk that wants a linked FILE asks for the
 *   links (`LinkedFiles`) and decides per link, by resolving it and checking
 *   it stays inside the root (see `discoverFiles`).
 * - **`deep` counts as the walks were written against:** `deep: n` reads a
 *   file at most n-1 directories below `cwd` (`deep: 1` is `cwd`'s own files).
 *
 * The engine is tinyglobby (fdir + picomatch). It replaced fast-glob on
 * 2026-10-11: fast-glob's micromatch pulls in `braces`, whose brace expansion
 * recurses without bound on a nested pattern (GHSA-vfj7-8cjw-p6xm), no fixed
 * release exists, and `--include` / `--exclude` hand it the user's patterns.
 */
import { glob as tinyGlob, globSync as tinyGlobSync, type GlobOptions as TinyGlobOptions } from "tinyglobby";
import { readdir, readdirSync, realpath, realpathSync, stat, statSync, type Dirent } from "fs";
import { resolve } from "path";

/**
 * The options ClarifyDoc's glob wrapper accepts — the engine's own options
 * never leak past this module, so swapping the engine is a one-file change.
 */
export interface GlobOptions {
  /** Directory the patterns and the results are relative to. */
  cwd: string;
  ignore?: readonly string[];
  /** Return absolute paths (default: relative to `cwd`). */
  absolute?: boolean;
  /** Match dotfiles (default false). */
  dot?: boolean;
  /** Default true; false lets a lower-case extension pattern match `UNIT1.PAS`. */
  caseSensitiveMatch?: boolean;
  /** See the module doc: a file at most `deep`-1 directories below `cwd`. */
  deep?: number;
  /** List symbolic links as if they were files, and record them here. */
  links?: LinkedFiles;
  /**
   * Directories not to enter, by absolute path — asked of each directory as
   * it is listed, so a pruned tree costs one call instead of a walk.
   */
  prune?: (absoluteDir: string) => boolean;
}

/**
 * The symbolic links a walk met. fdir drops every link when told not to
 * follow them, and following is exactly what no walk may do — so a walk that
 * wants links is handed a `readdir` that reports each link as a plain file
 * (listed, never descended) and records its absolute path here. The caller
 * then tells a link from a file without a stat per result.
 */
export class LinkedFiles {
  private readonly paths = new Set<string>();

  /** Report each link in one directory listing as a file, recording it. */
  record(dir: string, entries: Dirent[]): Dirent[] {
    return entries.map((entry) => {
      if (!entry.isSymbolicLink()) return entry;
      this.paths.add(resolve(dir, entry.name));
      return Object.create(entry, {
        isSymbolicLink: { value: () => false },
        isFile: { value: () => true },
        isDirectory: { value: () => false },
      }) as Dirent;
    });
  }

  /** Whether `absolutePath` was listed as a link. */
  has(absolutePath: string): boolean {
    return this.paths.has(absolutePath);
  }
}

/**
 * The file-system adapter a walk runs on when it records links or prunes
 * directories: every listing passes through here before fdir sees it.
 */
function walkFs(
  links: LinkedFiles | undefined,
  prune: ((absoluteDir: string) => boolean) | undefined,
): NonNullable<TinyGlobOptions["fs"]> {
  const filter = (dir: string, entries: Dirent[]): Dirent[] => {
    const kept = prune ? entries.filter((e) => !(e.isDirectory() && prune(resolve(dir, e.name)))) : entries;
    return links ? links.record(dir, kept) : kept;
  };
  return {
    stat,
    statSync,
    realpath,
    realpathSync,
    readdir: ((dir: string, options: { withFileTypes: true }, cb: (err: NodeJS.ErrnoException | null, entries: Dirent[]) => void) =>
      readdir(dir, options, (err, entries) => cb(err, err ? [] : filter(dir, entries)))) as typeof readdir,
    readdirSync: ((dir: string, options: { withFileTypes: true }) =>
      filter(dir, readdirSync(dir, options))) as typeof readdirSync,
  };
}

/**
 * Translate `GlobOptions` to the engine's options, pinning the behaviours the
 * wrapper promises (no symlink following, no directory expansion).
 */
function toEngine({ cwd, ignore, absolute, dot, caseSensitiveMatch, deep, links, prune }: GlobOptions): TinyGlobOptions {
  const options: TinyGlobOptions = {
    cwd,
    followSymbolicLinks: false,
    expandDirectories: false,
    absolute: absolute ?? false,
    dot: dot ?? false,
    caseSensitiveMatch: caseSensitiveMatch ?? true,
  };
  if (ignore) options.ignore = [...ignore];
  if (deep !== undefined) options.deep = deep - 1;
  if (links || prune) options.fs = walkFs(links, prune);
  return options;
}

/**
 * Match `patterns` under `options.cwd` without following symbolic links.
 *
 * @returns Matching paths, relative to `cwd` unless `absolute` is set
 */
export async function glob(patterns: string | readonly string[], options: GlobOptions): Promise<string[]> {
  return sorted(await tinyGlob(patterns, toEngine(options)));
}

/** Synchronous `glob`, for callers that cannot await. */
export function globSync(patterns: string | readonly string[], options: GlobOptions): string[] {
  return sorted(tinyGlobSync(patterns, toEngine(options)));
}

/**
 * Results in code-point order. The async walk lists directories as their reads
 * complete, so two runs over one tree returned the same paths in different
 * orders — and every caller that keeps the first of several (a manifest a
 * `limit` cuts, the first declaration of a package) wrote different output.
 */
function sorted(paths: string[]): string[] {
  return paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
