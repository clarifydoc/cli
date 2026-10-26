import type { MigrationFileRule } from "../../../types/language-plugin.js";

/**
 * EF Core: `Migrations/<timestamp>_<Name>.cs`. Each migration also ships a
 * `<name>.Designer.cs` companion (same migration, generated metadata) and the
 * project has one `<Context>ModelSnapshot.cs` (current model state, not a
 * migration) — both are left out so a migration is counted exactly once.
 */
export const csharpMigrationFiles: MigrationFileRule[] = [
  (p) => {
    const m = p.match(/(?:^|\/)Migrations\/([^/]+)\.cs$/);
    if (!m || /ModelSnapshot$/.test(m[1]!) || /\.Designer$/.test(m[1]!)) return null;
    return { ecosystem: "ef-core", name: m[1]! };
  },
];
