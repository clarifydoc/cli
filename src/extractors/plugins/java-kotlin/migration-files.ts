import type { MigrationFileRule } from "../../../types/language-plugin.js";

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
const stripExt = (name: string): string => (name.lastIndexOf(".") > 0 ? name.slice(0, name.lastIndexOf(".")) : name);

/**
 * The JVM's migration tools: Liquibase changelogs under a liquibase/changelog
 * directory or named for one (`db.changelog-master.xml`, `changelog-1.2.yaml`),
 * and Flyway's `V<version>__<name>.sql` (also repeatable `R__<name>.sql`).
 */
export const jvmMigrationFiles: MigrationFileRule[] = [
  (p) =>
    /\.(?:xml|ya?ml|json)$/i.test(p) && (/(?:^|\/)(?:liquibase|changelogs?)\//i.test(p) || /changelog/i.test(baseName(p)))
      ? { ecosystem: "liquibase", name: stripExt(baseName(p)) }
      : null,
  (p) => (/^(V[\d._]+__.+|R__.+)\.sql$/.test(baseName(p)) ? { ecosystem: "flyway", name: stripExt(baseName(p)) } : null),
];
