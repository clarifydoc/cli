import type { MigrationFileRule } from "../../../types/language-plugin.js";

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const stripExt = (name: string): string => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/** TypeORM (13-digit millisecond timestamp, `.ts`) vs Sequelize (14-digit datetime, or `.js`) under a migrations directory. */
export const jsMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = baseName(p).match(/^(\d{6,})[-_](.+)\.(ts|js)$/);
    if (!m || !/(?:^|\/)migrations?\//i.test(p)) return null;
    return { ecosystem: m[1]!.length >= 14 || m[3] === "js" ? "sequelize" : "typeorm", name: stripExt(baseName(p)) };
  },
];
