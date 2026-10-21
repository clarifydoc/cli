import type { MigrationInfo } from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";

/**
 * Detect ORM/DB migration files from a list of (relative) project file paths,
 * purely by path/name convention — migrations are directory conventions and
 * don't benefit from AST parsing. Each file is classified into at most one
 * ecosystem; the more specific patterns are tried first.
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

/** The last path segment. */
function baseName(p: string): string {
  const slash = p.lastIndexOf("/");
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/** The file name without its extension (a leading dot is kept). */
function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Build a `MigrationInfo` with its sort key derived from the name. */
function mk(filePath: string, ecosystem: MigrationInfo["ecosystem"], name: string): MigrationInfo {
  return { filePath, ecosystem, name, order: orderKey(name) };
}

/**
 * Recognize a migration file by the path conventions of each ecosystem
 * (Prisma, Diesel, Flyway, Rails, Django, Alembic, EF Core, Doctrine,
 * GORM), in the order tried below. Null when the path matches none.
 */
function classify(p: string): MigrationInfo | null {
  let m: RegExpMatchArray | null;

  // Prisma: prisma/migrations/<timestamp>_<slug>/migration.sql
  m = p.match(/(?:^|\/)prisma\/migrations\/([^/]+)\/migration\.sql$/i);
  if (m) return mk(p, "prisma", m[1]!);

  // Diesel: migrations/<timestamp>_<name>/up.sql (down.sql ignored to dedup)
  m = p.match(/(?:^|\/)migrations\/([^/]+)\/up\.sql$/i);
  if (m) return mk(p, "diesel", m[1]!);

  // Liquibase: changelogs under a liquibase/changelog directory, or named for one
  // (`db.changelog-master.xml`, `changelog-1.2.yaml`).
  if (/\.(?:xml|ya?ml|json)$/i.test(p) && (/(?:^|\/)(?:liquibase|changelogs?)\//i.test(p) || /changelog/i.test(baseName(p)))) {
    return mk(p, "liquibase", stripExt(baseName(p)));
  }

  // Flyway: V<version>__<name>.sql (also repeatable R__name.sql)
  m = baseName(p).match(/^(V[\d._]+__.+|R__.+)\.sql$/);
  if (m) return mk(p, "flyway", stripExt(baseName(p)));

  // Rails: db/migrate/<version>_<name>.rb
  m = p.match(/(?:^|\/)db\/migrate\/(\d+_[^/]+)\.rb$/);
  if (m) return mk(p, "rails", m[1]!);

  // Alembic: alembic/versions/<rev>_<name>.py  OR  versions/<rev>_<name>.py
  m = p.match(/(?:^|\/)(?:alembic\/)?versions\/([0-9a-f]{6,}_[^/]+)\.py$/i);
  if (m) return mk(p, "alembic", m[1]!);

  // Django: <app>/migrations/<NNNN>_<name>.py (skip __init__.py)
  m = p.match(/(?:^|\/)migrations\/(\d{3,}_[^/]+)\.py$/);
  if (m) return mk(p, "django", m[1]!);

  // EF Core: Migrations/<timestamp>_<Name>.cs. Each migration also ships a
  // `<name>.Designer.cs` companion (same migration, generated metadata) and the
  // project has one `<Context>ModelSnapshot.cs` (current model state, not a
  // migration) — both are excluded so a migration is counted exactly once.
  m = p.match(/(?:^|\/)Migrations\/([^/]+)\.cs$/);
  if (m) {
    const name = m[1]!;
    if (/ModelSnapshot$/.test(name) || /\.Designer$/.test(name)) return null;
    return mk(p, "ef-core", name);
  }

  // Doctrine: Migrations/Version*.php
  m = p.match(/(?:^|\/)[Mm]igrations\/(Version\w+)\.php$/);
  if (m) return mk(p, "doctrine", m[1]!);

  // GORM: migrations/*.go
  m = p.match(/(?:^|\/)migrations\/([^/]+)\.go$/);
  if (m) return mk(p, "gorm", m[1]!);

  // TypeORM (13-digit ms timestamp) vs Sequelize (14-digit datetime), .ts/.js
  m = baseName(p).match(/^(\d{6,})[-_](.+)\.(ts|js)$/);
  if (m && /(?:^|\/)migrations?\//i.test(p)) {
    const digits = m[1]!;
    const ext = m[3]!;
    const ecosystem: MigrationInfo["ecosystem"] =
      digits.length >= 14 || ext === "js" ? "sequelize" : "typeorm";
    return mk(p, ecosystem, stripExt(baseName(p)));
  }

  return null;
}
