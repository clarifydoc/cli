import type { MigrationInfo } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { MIGRATION_FILE_RULES } from "../extractors/registry.js";

/**
 * Detect ORM/DB migration files from a list of (relative) project file paths,
 * purely by path/name convention — migrations are directory conventions and
 * don't benefit from AST parsing. Each plugin declares its tools' conventions
 * (`migrationFiles`); each file is classified into at most one ecosystem.
 *
 * Only files already discovered by the analyzer are considered, so a Liquibase
 * changelog surfaces when its plugin reads it (XML today).
 */
export function detectMigrations(filePaths: string[]): MigrationInfo[] {
  const out: MigrationInfo[] = [];
  for (const raw of filePaths) {
    const p = raw.replace(/\\/g, "/");
    const info = classify(p);
    if (info) out.push(info);
  }
  // Chronological within ecosystem, then by ecosystem name for stable output.
  out.sort(
    (a, b) =>
      byOrdinal(a.ecosystem, b.ecosystem) ||
      byVersion(a.order, b.order) ||
      byOrdinal(a.filePath, b.filePath),
  );
  return out;
}

/**
 * Migration order: by the version numbers the key starts with, segment by
 * segment (`V2__x` < `V10__x`, `V1.2` < `V1.10`, a 14-digit timestamp as one
 * number), then as text. Text alone put Flyway's V10 before V2.
 */
export function byVersion(a: string, b: string): number {
  const va = versionOf(a);
  const vb = versionOf(b);
  if (va && vb) {
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const x = va[i] ?? -1n;
      const y = vb[i] ?? -1n;
      if (x !== y) return x < y ? -1 : 1;
    }
  }
  return byOrdinal(a, b);
}

function versionOf(key: string): bigint[] | null {
  const m = /^[A-Za-z]?(\d+(?:[._]\d+)*)(?![\d])/.exec(key);
  return m ? m[1]!.split(/[._]/).map((d) => BigInt(d)) : null;
}

/** Leading digit run of a name (timestamp / version), else the whole name. */
function orderKey(name: string): string {
  const m = name.match(/^(\d+)/);
  return m ? m[1]! : name;
}

/**
 * The first plugin rule that recognises the path (`LanguagePluginManifest.migrationFiles`);
 * core names no ecosystem itself. Null when none does.
 */
function classify(p: string): MigrationInfo | null {
  for (const rule of MIGRATION_FILE_RULES) {
    const hit = rule(p);
    if (hit) return { filePath: p, ecosystem: hit.ecosystem, name: hit.name, order: orderKey(hit.name) };
  }
  return null;
}
