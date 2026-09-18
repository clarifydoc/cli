/**
 * Ordinal (code-unit) string comparison, for every ordering that reaches disk.
 *
 * `String.prototype.localeCompare` with no locale argument uses the process
 * default, which follows LANG/LC_ALL and the bundled ICU. The same file list
 * therefore sorts differently per machine: Swedish puts `Ä` last, Maltese puts
 * uppercase before lowercase, Turkish swaps `Index.ts` and `index.ts`.
 *
 * That is not a cosmetic difference here. File discovery's sort order seeds
 * `files[]`, and `files[]` numbers every page id in `project-summary.json` and
 * `report-data.json`; it also seeds community ids and the tie order of every
 * comparator that does not fully order its input. So an analysis run in one
 * locale and an analysis run in another disagree throughout, and a fixture
 * regenerated on a machine with another locale looks like an extraction change.
 *
 * Ordinal comparison is identical everywhere. Use it for anything persisted;
 * locale-aware collation belongs in the viewer, where a human reads it.
 */

/** Compare two strings by code unit. Stable across locales and ICU versions. */
export function byOrdinal(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator over a derived string key, e.g. `sort(byOrdinalKey(f => f.path))`. */
export function byOrdinalKey<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => byOrdinal(key(a), key(b));
}
