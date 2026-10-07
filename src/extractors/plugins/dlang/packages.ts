import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * dub package recognition. Rules are matched by name across ecosystems, so
 * only names that are D's own are listed.
 */
export const dubPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["vibe-d", "vibe-http", "vibe-core"], category: "framework", framework: { id: "vibe-d", name: "vibe.d" } },
  { names: ["hunt-framework"], category: "framework", framework: { id: "hunt", name: "Hunt Framework" } },
  { names: ["handy-httpd", "serverino", "arsd-official"], category: "framework" },
  // ── ORM / database ──
  { names: ["hibernated", "ddbc", "dpq2", "mysql-native", "d2sqlite3", "mondo"], category: "database" },
  // ── Serialization ──
  { names: ["asdf", "mir-ion", "dyaml", "sdlang-d"], category: "serialization" },
  // ── Testing ──
  { names: ["unit-threaded", "silly", "dshould", "fluent-asserts"], category: "testing" },
  // ── Utility ──
  { names: ["mir-algorithm", "taggedalgebraic", "eventcore", "stdx-allocator", "userman"], category: "util" },
];
