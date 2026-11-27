import { readFile, writeFile, stat, mkdir, rename, unlink } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { readSourceText } from "./read-text-file.js";
import { createHash } from "crypto";
import { join, resolve, sep } from "path";
import { getLanguageForFile } from "../parsers/language-map.js";
import { headCommit, listGitFiles } from "./source-revision.js";
import { featureStamp } from "./feature-flags.js";
import { byOrdinal } from "./ordinal.js";
import type { Language } from "../types/analysis.js";
import type { PreprocessContext } from "../types/language-plugin.js";

/**
 * Bump whenever extractor logic changes in a way that would produce different
 * FileAnalysis output for the same source bytes. A mismatch between the value
 * stored in the manifest and this constant invalidates the whole cache so a
 * fixed extractor never leaves stale JSON behind.
 */
export const EXTRACTOR_VERSION = "1.778.0";

/**
 * What a cache written by this run is stamped with: `EXTRACTOR_VERSION`, and
 * the features switched away from their defaults (`1.578.0+-antlr`), so a run
 * reading files another way re-extracts instead of reusing its JSON.
 */
export function extractorStamp(): string {
  const features = featureStamp();
  return features ? `${EXTRACTOR_VERSION}+${features}` : EXTRACTOR_VERSION;
}

/**
 * Order two extractor stamps by their version alone (`1.603.0+-antlr` reads as
 * 1.603.0): negative when `a` is older, positive when newer, 0 when the same
 * version. Null when either does not start with a dotted number.
 */
export function compareExtractorVersions(a: string, b: string): number | null {
  const parts = (stamp: string): number[] | null => {
    const m = /^(\d+(?:\.\d+)*)/.exec(stamp.split("+")[0]!.trim());
    return m ? m[1]!.split(".").map(Number) : null;
  };
  const pa = parts(a);
  const pb = parts(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The stamp of the engine that wrote the analysis in `outputDir` when it is a
 * NEWER engine than this one, else null. A running server older than the
 * analysis it serves must not rewrite it: what it would write is the older
 * reading.
 */
export async function newerAnalysisEngine(outputDir: string): Promise<string | null> {
  const manifest = await loadManifestRaw(outputDir);
  if (!manifest || typeof manifest.extractorVersion !== "string") return null;
  return (compareExtractorVersions(manifest.extractorVersion, extractorStamp()) ?? 0) > 0 ? manifest.extractorVersion : null;
}

/**
 * What the manifest remembers about one analyzed file, enough to tell
 * whether its cached JSON can be reused.
 */
export interface ManifestEntry {
  /** Modification time as ms since epoch. Fast-path check before hashing. */
  mtime: number;
  /** SHA-256 of file contents — definitive change check. */
  sha256: string;
  /**
   * Fingerprint of the configuration the file's imports were rewritten with
   * (path aliases, workspace packages): the cached analysis is reused only
   * while it is unchanged. Absent when no such configuration applies.
   */
  resolver?: string;
}

/**
 * The on-disk `manifest.json`: one entry per analyzed file, stamped with the
 * extractor version that produced them.
 */
export interface Manifest {
  version: 1;
  /** Bumping EXTRACTOR_VERSION invalidates the whole manifest. */
  extractorVersion: string;
  /** Keys are POSIX relative paths. */
  entries: Record<string, ManifestEntry>;
  /**
   * Files a plugin refused by their content (preprocess `{ skip }`: a JSON file that is not an API
   * spec, a foreign-format `.xml`). Kept apart from `entries`, which are the analyzed files, so the
   * next incremental run skips them unread while the bytes are the same.
   */
  skipped?: Record<string, ManifestEntry>;
  /** The commit the analysis was made at, when known — what freshness compares HEAD to. */
  revision?: { commit: string; branch: string | null };
  /** What the run was made from besides the files (`runFingerprint`): equal next time, with no file changed, means up to date. */
  fingerprint?: string;
  /** The same with documentation left out (`runFingerprints().code`): equal while `fingerprint` is not means only prose changed. */
  codeFingerprint?: string;
  /** The options the run was made with that a rerun needs — see {@link RunOptions}. Absent in manifests of older runs. */
  runOptions?: RunOptions;
}

/**
 * What a background refresh needs to repeat a run: the switches only, never a token, an environment value or an
 * absolute path. The fingerprints above are hashes and cannot be turned back into these.
 */
export interface RunOptions {
  /** `--include` / `--exclude` globs and `--max-files`, as given. `--spec` and `--coverage` files are recorded relative to the project root; one outside the tree is not recorded. */
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  /** `--spec` / `--coverage` files, project-relative POSIX paths. */
  spec?: string[];
  coverage?: string[];
  /** Whether LSP enhancement was on (`analyze` runs it unless `--no-lsp`). */
  lsp: boolean;
  /** `--feature` names that deviate from the defaults, as `analyze --feature` takes them (`no-antlr`, `tree-sitter:swift`). */
  features: string[];
  /** Whether git churn and co-change were read (`--no-git-history` turns it off). */
  gitHistory: boolean;
}

const MANIFEST_NAME = "manifest.json";

/** Normalize a path key for use in the manifest: posix separators, no `\\?\` prefix. */
export function normalizeManifestKey(relPath: string): string {
  let s = relPath;
  if (s.startsWith("\\\\?\\")) s = s.slice(4);
  return s.split(sep).join("/");
}

/**
 * Load the manifest from `<outputDir>/manifest.json`. Returns null if missing,
 * malformed, or written by a different extractor version (latter forces a full
 * re-extract — exactly what we want when the analysis pipeline has changed).
 */
export async function loadManifest(outputDir: string): Promise<Manifest | null> {
  const path = join(resolve(outputDir), MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (parsed.version !== 1) return null;
    if (parsed.extractorVersion !== extractorStamp()) return null;
    if (!parsed.entries || typeof parsed.entries !== "object") return null;
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/**
 * Save the manifest atomically: write a temp file then rename. On Windows
 * `rename` over an existing file works but a transient lock can cause
 * EACCES — we retry once via overwrite-and-unlink as fallback.
 */
export async function saveManifest(outputDir: string, manifest: Manifest): Promise<void> {
  const dir = resolve(outputDir);
  await mkdir(dir, { recursive: true });
  const finalPath = join(dir, MANIFEST_NAME);
  const tmpPath = join(dir, `${MANIFEST_NAME}.${process.pid}.tmp`);

  // Entries arrive in the order files finished: sorted, two runs over the same tree write the same bytes.
  const sorted = <T>(of: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(of).sort(([x], [y]) => byOrdinal(x, y)));
  const body = JSON.stringify({ ...manifest, entries: sorted(manifest.entries), ...(manifest.skipped ? { skipped: sorted(manifest.skipped) } : {}) }, null, 2);
  await writeFile(tmpPath, body, "utf-8");
  try {
    await rename(tmpPath, finalPath);
  } catch (err) {
    // Windows fallback: overwrite then drop the temp file.
    try {
      await writeFile(finalPath, body, "utf-8");
      await unlink(tmpPath).catch(() => undefined);
    } catch {
      throw err;
    }
  }
}

/**
 * Read the manifest WITHOUT the extractor-version gate, so a caller can tell
 * "written by an older extractor" apart from "no manifest at all". The normal
 * loader collapses both to null, which is right for cache reuse and wrong for
 * reporting freshness.
 */
export async function loadManifestRaw(outputDir: string): Promise<Manifest | null> {
  const path = join(resolve(outputDir), MANIFEST_NAME);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as Partial<Manifest>;
    if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return null;
    return parsed as Manifest;
  } catch {
    return null;
  }
}

/**
 * Whether a written analysis still describes the source tree, as judged by
 * `assessFreshness` from the manifest alone (no re-analysis).
 */
export interface FreshnessReport {
  /**
   * `fresh` — every recorded file still matches.
   * `changed` — at least one recorded file was edited or removed.
   * `extractor-changed` — the manifest predates the current extractor, so the
   *   analysis would differ even for untouched source.
   * `engine-older` — the manifest was written by a NEWER extractor than the
   *   one running: the analysis is not stale, this engine is. Re-analyzing
   *   with it would replace the newer reading with an older one.
   * `unknown` — no manifest (a non-incremental run writes none), so nothing
   *   can be compared. Deliberately not reported as `fresh`.
   */
  state: "fresh" | "changed" | "extractor-changed" | "engine-older" | "unknown";
  /** With `extractor-changed` and `engine-older`: the stamp that wrote the analysis, and the running one. */
  engine?: { analysis: string; running: string };
  changed: string[];
  removed: string[];
  /**
   * Source files git lists that the analysis has not seen and that appeared
   * after it — in a directory it covers, in a language it reads (capped).
   */
  added: string[];
  /** The commit the analysis was made at, and HEAD now, when they differ. */
  head?: { analyzed: string; now: string };
  /** How many manifest entries were examined. */
  checked: number;
  /** True when `maxStats` capped the check, so `changed`/`removed` may be short. */
  sampled: boolean;
}

/** Entries examined before the freshness probe stops and reports `sampled`. */
const FRESHNESS_STAT_CAP = 5000;

/**
 * Compare a written analysis against the source tree it describes.
 *
 * The only staleness signal available before this was "analyzed 3 hours ago",
 * which says nothing about whether the code moved. The manifest already holds
 * an mtime and a SHA-256 per file, so the answer is a stat per entry and a hash
 * only where the mtime shifted.
 *
 * Added files come from git, not from re-running discovery (most of an
 * analysis): a file git lists, in a directory the analysis covers and a
 * language it reads (by extension, or an extension-less script by its `#!`
 * line where discovery looks for one), written after the manifest was, and not one discovery
 * refuses: a file the analysis read and its plugin refused (`skipped`, however
 * recently touched — a `package.json` is no API spec), or a newer one that the
 * same plugin, the sensitive-name rule or `.clarifydoc-ignore` would refuse.
 * `git: false` skips that and the HEAD comparison.
 */
export async function assessFreshness(
  outputDir: string,
  projectRoot: string,
  opts: { maxStats?: number; git?: boolean } = {},
): Promise<FreshnessReport> {
  const manifest = await loadManifestRaw(outputDir);
  if (!manifest) return { state: "unknown", changed: [], removed: [], added: [], checked: 0, sampled: false };
  const running = extractorStamp();
  if (manifest.extractorVersion !== running) {
    // Compared as versions, not strings: a manifest a newer engine wrote is not stale.
    const order = compareExtractorVersions(String(manifest.extractorVersion), running);
    return {
      state: order !== null && order > 0 ? "engine-older" : "extractor-changed",
      engine: { analysis: String(manifest.extractorVersion), running },
      changed: [], removed: [], added: [], checked: 0, sampled: false,
    };
  }

  const cap = opts.maxStats ?? FRESHNESS_STAT_CAP;
  const keys = Object.keys(manifest.entries).sort();
  const sampled = keys.length > cap;
  const examined = sampled ? keys.slice(0, cap) : keys;

  const changed: string[] = [];
  const removed: string[] = [];
  for (const rel of examined) {
    const entry = manifest.entries[rel]!;
    const abs = join(resolve(projectRoot), rel);
    try {
      const classified = await classifyFile(abs, entry);
      if (classified.state !== "unchanged") changed.push(rel);
    } catch {
      removed.push(rel); // stat failed: deleted, renamed, or no longer readable
    }
  }

  const added: string[] = [];
  let head: FreshnessReport["head"];
  if (opts.git !== false) {
    const now = manifest.revision ? await headCommit(projectRoot) : null;
    if (manifest.revision && now && now !== manifest.revision.commit) head = { analyzed: manifest.revision.commit, now };
    const listed = await listGitFiles(projectRoot);
    const written = listed ? await stat(join(outputDir, MANIFEST_NAME)).then((x) => x.mtimeMs, () => Infinity) : Infinity;
    if (listed && Number.isFinite(written)) {
      const dirs = new Set(keys.map((k) => k.slice(0, k.lastIndexOf("/") + 1)));
      const reads = discoveryReads(projectRoot);
      let stats = 0;
      for (const rel of listed) {
        if (added.length >= ADDED_CAP || stats >= cap) break;
        if (manifest.entries[rel] || manifest.skipped?.[rel] || !dirs.has(rel.slice(0, rel.lastIndexOf("/") + 1))) continue;
        // No language by extension: an extension-less name may still be a script its `#!` line names.
        const language = getLanguageForFile(rel);
        if (!language && rel.slice(rel.lastIndexOf("/") + 1).includes(".")) continue;
        stats++;
        const m = await stat(join(resolve(projectRoot), rel)).then((x) => x.mtimeMs, () => 0);
        if (m > written && (await reads(rel, language))) added.push(rel);
      }
    }
  }

  return {
    state: changed.length + removed.length + added.length > 0 ? "changed" : "fresh",
    changed,
    removed,
    added,
    ...(head ? { head } : {}),
    checked: examined.length,
    sampled,
  };
}

/** Added files reported before the list stops. */
const ADDED_CAP = 200;

/**
 * Whether discovery would read a file the manifest has never seen. A file with no language by extension
 * is read only as a script its `#!` line names, where discovery looks for one (`shebangScriptAt`). Any
 * file is refused for a credential-looking name (never opened), a `.clarifydoc-ignore` match, or its
 * plugin's `preprocess` returning `{ skip }` (a `.json` that is no API spec). Discovery and the registry
 * load on the first candidate only — most checks find none. A plugin that throws refuses nothing: the
 * file is named, as before.
 */
function discoveryReads(projectRoot: string): (rel: string, language: Language | null) => Promise<boolean> {
  const root = resolve(projectRoot);
  let rules: Promise<{
    script: (rel: string) => Language | null;
    sensitive: (rel: string, language: Language) => boolean;
    ignored: (abs: string) => boolean;
    applies: (language: Language, rel: string) => boolean;
    preprocess: (language: Language, raw: string, rel: string, context: PreprocessContext) => ReturnType<typeof import("../extractors/registry.js").preprocessFile>;
  }> | undefined;
  return async (rel, byExtension) => {
    rules ??= Promise.all([import("./file-discovery.js"), import("./clarifydoc-ignore.js"), import("../extractors/registry.js")]).then(
      ([discovery, ignore, registry]) => {
        const patterns = ignore.loadIgnorePatterns(root);
        return {
          script: (path: string) => discovery.shebangScriptAt(root, path),
          sensitive: discovery.isSensitive,
          ignored: (abs: string) => ignore.isIgnored(abs, root, patterns),
          applies: registry.preprocessApplies,
          preprocess: registry.preprocessFile,
        };
      },
    );
    const { script, sensitive, ignored, applies, preprocess } = await rules;
    const language = byExtension ?? script(rel);
    if (!language) return false;
    if (sensitive(rel, language)) return false;
    const abs = join(root, rel);
    if (ignored(abs)) return false;
    if (!applies(language, rel)) return true;
    try {
      const pre = await preprocess(language, await readSourceText(abs), rel, { absolutePath: abs, projectRoot: root });
      return !(pre && "skip" in pre);
    } catch {
      return true;
    }
  };
}

/**
 * Determine the cache state of a file relative to a previous manifest entry.
 *   "unchanged" — mtime matches, or content hash matches (sync tools touch mtime)
 *   "changed"   — content hash differs from cache
 *   "new"       — no prior entry
 *
 * The mtime fast-path avoids hashing in the common case; the hash slow-path
 * is what makes the cache resilient to mtime churn.
 */
export async function classifyFile(
  absPath: string,
  prev: ManifestEntry | undefined,
): Promise<{ state: "unchanged" | "changed" | "new"; mtime: number; sha256: string }> {
  const s = await stat(absPath);
  const mtime = s.mtimeMs;

  if (!prev) {
    const sha256 = await hashFile(absPath);
    return { state: "new", mtime, sha256 };
  }

  if (prev.mtime === mtime) {
    // Fast path: mtime unchanged means the cached entry is good. Trust the
    // stored hash to keep classifyFile cheap; full rehash only fires when
    // mtime actually shifted.
    return { state: "unchanged", mtime, sha256: prev.sha256 };
  }

  const sha256 = await hashFile(absPath);
  if (sha256 === prev.sha256) {
    // Content matches — only the mtime bumped (sync tool, branch switch).
    return { state: "unchanged", mtime, sha256 };
  }
  return { state: "changed", mtime, sha256 };
}

/**
 * Delete per-file FileAnalysis JSON left behind by sources that no longer
 * exist. A key present in the previous manifest but absent from the new one is
 * a file removed/renamed since the last run; its `<outputDir>/<rel>.json` cache
 * would otherwise linger — reused by a future `loadCachedFileResult`, listed by
 * the server's file browser, and counted as a phantom file. Best-effort:
 * unlink failures are swallowed. Returns the number removed.
 */
export async function cleanupStaleArtifacts(
  outputDir: string,
  prevKeys: Iterable<string>,
  currentKeys: Set<string>,
): Promise<number> {
  const dir = resolve(outputDir);
  let removed = 0;
  for (const key of prevKeys) {
    if (currentKeys.has(key)) continue;
    try {
      await unlink(join(dir, `${key}.json`));
      removed++;
    } catch {
      // Already gone or never written — nothing to clean.
    }
  }
  return removed;
}

/** Stream the file through SHA-256. 64KB chunks, no buffering of the whole file. */
export function hashFile(absPath: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash("sha256");
    const stream = createReadStream(absPath, { highWaterMark: 64 * 1024 });
    stream.on("data", (chunk) => h.update(chunk));
    stream.on("end", () => res(h.digest("hex")));
    stream.on("error", rej);
  });
}
