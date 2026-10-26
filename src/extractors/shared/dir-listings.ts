import { readdirSync } from "fs";

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
    names = readdirSync(dir);
  } catch {
    names = null;
  }
  listings.set(dir, names);
  return names;
}

export function clearDirectoryListings(): void {
  listings.clear();
}
