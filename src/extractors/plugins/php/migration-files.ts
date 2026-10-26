import type { MigrationFileRule } from "../../../types/language-plugin.js";

/** Doctrine: `Migrations/Version*.php`. */
export const phpMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)[Mm]igrations\/(Version\w+)\.php$/);
    return m ? { ecosystem: "doctrine", name: m[1]! } : null;
  },
];
