import { readdirSync, type Dirent } from "fs";

/**
 * Directory listings (names only) read once per analysis and shared by the
 * import-configuration lookups: the workspace-package walk lists every
 * directory it passes, and the bundler-config lookup of the same directory
 * reuses that listing instead of reading the directory again. Keyed by the
 * absolute path as resolved; cleared with the configuration caches.
 */
const listings = new Map<string, readonly string[] | null>();

/** Remember a listing just read (`readdirSync`), so a later lookup of `dir` reuses it. */
export function rememberListing(dir: string, names: readonly string[]): void {
  listings.set(dir, names);
}

/** The names in `dir`, read once per analysis; null when it cannot be read. */
export function listDirectory(dir: string): readonly string[] | null {
  const hit = listings.get(dir);
  if (hit !== undefined) return hit;
  let names: readonly string[] | null;
  try {
    names = sharedEntries(dir)?.map((e) => e.name) ?? readdirSync(dir);
  } catch {
    names = null;
  }
  listings.set(dir, names);
  return names;
}

/**
 * Directory entries (with their types) shared by every walk of one analysis.
 * A run walks its tree a dozen times and more — discovery, project markers,
 * framework files, deployment descriptors, pipelines, documents — and each
 * walk listed every directory again: on a tree of 1,800 directories that is
 * 100 ms a walk against 10 ms over listings already read. Shared only while
 * an analysis runs (`shareDirectoryEntries`), so a long-lived process never
 * answers from a listing an earlier run read. Entries are as the file system
 * gave them; a walk applies its own filters to a copy.
 */
const entryListings = new Map<string, readonly Dirent[]>();
let sharing = 0;

const listingKey = (dir: string): string => (dir.length > 1 && (dir.endsWith("/") || dir.endsWith("\\")) ? dir.slice(0, -1) : dir);

/** Start sharing listings; call the returned function when the analysis ends (the last one out empties them). */
export function shareDirectoryEntries(): () => void {
  sharing++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    if (--sharing === 0) entryListings.clear();
  };
}

/** The entries of `dir` a walk of this analysis already read, if any. */
export function sharedEntries(dir: string): readonly Dirent[] | undefined {
  return sharing > 0 ? entryListings.get(listingKey(dir)) : undefined;
}

/** Keep a listing just read for the other walks of this analysis. `dir` must be absolute. */
export function shareEntries(dir: string, entries: readonly Dirent[]): void {
  if (sharing > 0) entryListings.set(listingKey(dir), entries);
}

/** `readdirSync(dir, { withFileTypes: true })`, answered from the shared listings where one was read. Throws as it does. */
export function listEntries(dir: string): readonly Dirent[] {
  const hit = sharedEntries(dir);
  if (hit) return hit;
  const entries = readdirSync(dir, { withFileTypes: true });
  shareEntries(dir, entries);
  return entries;
}

export function clearDirectoryListings(): void {
  listings.clear();
}
