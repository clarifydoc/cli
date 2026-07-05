import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** pub.dev package recognition (Dart / Flutter). Plugin-owned. */
export const pubPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["flutter"], category: "frontend", framework: { id: "flutter", name: "Flutter" } },
  { names: ["shelf", "shelf_router"], category: "framework", framework: { id: "shelf", name: "Shelf" } },
  { names: ["dart_frog"], category: "framework", framework: { id: "dart_frog", name: "Dart Frog" } },
  { names: ["get"], category: "state", framework: { id: "getx", name: "GetX" } },
  // ── State management ──
  { names: ["provider", "riverpod", "flutter_riverpod", "flutter_bloc", "bloc"], category: "state" },
  // ── HTTP ──
  { names: ["dio", "http", "chopper", "retrofit"], category: "http" },
  // ── Database / local storage ──
  { names: ["sqflite", "hive", "isar", "drift", "shared_preferences"], category: "database" },
  // ── Routing ──
  { names: ["go_router", "auto_route", "fluro"], category: "framework" },
];
