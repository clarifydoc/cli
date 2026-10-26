import type { MigrationFileRule } from "../../../types/language-plugin.js";

/**
 * Alembic (`alembic/versions/<rev>_<name>.py` or `versions/<rev>_<name>.py`),
 * tried before Django (`<app>/migrations/<NNNN>_<name>.py`; `__init__.py` is none).
 */
export const pythonMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)(?:alembic\/)?versions\/([0-9a-f]{6,}_[^/]+)\.py$/i);
    return m ? { ecosystem: "alembic", name: m[1]! } : null;
  },
  (p) => {
    const m = p.match(/(?:^|\/)migrations\/(\d{3,}_[^/]+)\.py$/);
    return m ? { ecosystem: "django", name: m[1]! } : null;
  },
];
