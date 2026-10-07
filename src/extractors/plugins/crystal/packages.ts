import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Crystal shard recognition. */
export const shardsPackages: readonly KnownPackageRule[] = [
  { names: ["kemal"], category: "framework", framework: { id: "kemal", name: "Kemal" } },
  { names: ["amber"], category: "framework", framework: { id: "amber", name: "Amber" } },
  { names: ["lucky"], category: "framework", framework: { id: "lucky", name: "Lucky" } },
  { names: ["athena", "athena-framework"], category: "framework", framework: { id: "athena", name: "Athena" } },
  { names: ["marten"], category: "framework", framework: { id: "marten", name: "Marten" } },
  { names: ["action-controller", "spider-gazelle"], category: "framework", framework: { id: "spider-gazelle", name: "Spider-Gazelle" } },
  { names: ["grip"], category: "framework" },
  { names: ["granite", "jennifer", "avram", "clear", "crecto"], category: "orm" },
  { names: ["db", "pg", "mysql", "sqlite3", "redis"], category: "database" },
  { names: ["crest", "halite"], category: "http" },
  { names: ["spectator", "webmock"], category: "testing" },
  { names: ["ameba"], category: "lint" },
];
