import type { MigrationFileRule } from "../../../types/language-plugin.js";

/** Rails: `db/migrate/<version>_<name>.rb`. */
export const rubyMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)db\/migrate\/(\d+_[^/]+)\.rb$/);
    return m ? { ecosystem: "rails", name: m[1]! } : null;
  },
];
