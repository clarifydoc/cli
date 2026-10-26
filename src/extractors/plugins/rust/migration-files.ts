import type { MigrationFileRule } from "../../../types/language-plugin.js";

/** Diesel: `migrations/<timestamp>_<name>/up.sql` (its `down.sql` is the same migration). */
export const rustMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)migrations\/([^/]+)\/up\.sql$/i);
    return m ? { ecosystem: "diesel", name: m[1]! } : null;
  },
];
