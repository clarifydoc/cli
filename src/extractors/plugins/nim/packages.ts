import type { KnownPackageRule } from "../../../types/language-plugin.js";

/**
 * Nimble package recognition. Rules are matched by name across ecosystems, so
 * only names that are Nim's own are listed.
 */
export const nimblePackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["jester"], category: "framework", framework: { id: "jester", name: "Jester" } },
  { names: ["prologue"], category: "framework", framework: { id: "prologue", name: "Prologue" } },
  { names: ["karax"], category: "frontend", framework: { id: "karax", name: "Karax" } },
  { names: ["httpbeast", "mummy"], category: "framework" },
  // ── ORM / database ──
  { names: ["norm", "ormin", "allographer"], category: "orm" },
  { names: ["db_connector", "db_sqlite", "db_postgres", "db_mysql", "tiny_sqlite"], category: "database" },
  // ── HTTP ──
  { names: ["puppy", "harpoon"], category: "http" },
  // ── Serialization ──
  { names: ["jsony", "nimyaml", "msgpack4nim", "packedjson"], category: "serialization" },
  // ── Testing ──
  { names: ["testament", "unittest2", "balls"], category: "testing" },
  // ── Utility ── (names other ecosystems share — `regex`, `redis` — are left to them)
  { names: ["nimcrypto", "cligen", "chronicles", "chronos"], category: "util" },
];
