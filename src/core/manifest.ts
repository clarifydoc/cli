import { readFile, writeFile, stat, mkdir, rename, unlink } from "fs/promises";
import { createReadStream, existsSync } from "fs";
import { createHash } from "crypto";
import { join, resolve, sep } from "path";

/**
 * Bump whenever extractor logic changes in a way that would produce different
 * FileAnalysis output for the same source bytes. A mismatch between the value
 * stored in the manifest and this constant invalidates the whole cache so a
 * fixed extractor never leaves stale JSON behind.
 */
export const EXTRACTOR_VERSION = "1.2.0";

export interface ManifestEntry {
  /** Modification time as ms since epoch. Fast-path check before hashing. */
  mtime: number;
  /** SHA-256 of file contents — definitive change check. */
  sha256: string;
}

export interface Manifest {
  version: 1;
  /** Bumping EXTRACTOR_VERSION invalidates the whole manifest. */
  extractorVersion: string;
  /** Keys are POSIX relative paths. */
  entries: Record<string, ManifestEntry>;
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
    if (parsed.extractorVersion !== EXTRACTOR_VERSION) return null;
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

  const body = JSON.stringify(manifest, null, 2);
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
