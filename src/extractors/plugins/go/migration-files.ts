import type { MigrationFileRule } from "../../../types/language-plugin.js";

/**
 * A versioned Go file under a migrations directory — `migrations/20240101_init.go`,
 * `modelmigration/v1_20/v250.go`. Any other Go file there (an importer, a test,
 * the runner) is none.
 */
export const goMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)\w*migrations?\/(?:v[\d_]+\/)?(\d{3,}[_-][^/]*|v\d+(?:_[^/]*)?)\.go$/i);
    return m && !/_test$/.test(m[1]!) ? { ecosystem: "gorm", name: m[1]! } : null;
  },
];
