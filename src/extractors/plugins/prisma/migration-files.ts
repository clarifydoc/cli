import type { MigrationFileRule } from "../../../types/language-plugin.js";

/** Prisma Migrate: `prisma/migrations/<timestamp>_<slug>/migration.sql`. */
export const prismaMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)prisma\/migrations\/([^/]+)\/migration\.sql$/i);
    return m ? { ecosystem: "prisma", name: m[1]! } : null;
  },
];
