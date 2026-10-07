import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Zig package recognition (build.zig.zon dependency names). */
export const zigPackages: readonly KnownPackageRule[] = [
  { names: ["zap"], category: "framework", framework: { id: "zap", name: "Zap" } },
  { names: ["httpz", "http.zig"], category: "framework", framework: { id: "httpz", name: "http.zig" } },
  { names: ["jetzig"], category: "framework", framework: { id: "jetzig", name: "Jetzig" } },
  { names: ["tokamak"], category: "framework", framework: { id: "tokamak", name: "Tokamak" } },
  { names: ["pg", "zqlite", "sqlite", "myzql", "okredis"], category: "database" },
  { names: ["clap", "zig-clap"], category: "util" },
];
