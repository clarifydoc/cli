import type { KnownPackageRule } from "../../../types/language-plugin.js";

/** Cargo crate recognition (Rust). Plugin-owned. */
export const cargoPackages: readonly KnownPackageRule[] = [
  // ── Frameworks ──
  { names: ["actix-web"], category: "framework", framework: { id: "actix", name: "Actix Web" } },
  { names: ["axum"], category: "framework", framework: { id: "axum", name: "Axum" } },
  { names: ["rocket"], category: "framework", framework: { id: "rocket", name: "Rocket" } },
  { names: ["warp"], category: "framework", framework: { id: "warp", name: "warp" } },
  { names: ["tide"], category: "framework", framework: { id: "tide", name: "Tide" } },
  { names: ["tonic"], category: "grpc", framework: { id: "tonic", name: "Tonic" } },
  // ── ORM ──
  { names: ["diesel", "sea-orm", "rusqlite"], category: "orm" },
  // ── HTTP ──
  { names: ["reqwest", "hyper"], category: "http" },
  // ── Serialization ──
  { names: ["serde", "serde_json"], category: "serialization" },
];
