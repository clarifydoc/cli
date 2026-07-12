import type { FrameworkRule } from "../../../types/language-plugin.js";
import { hasCargoDep } from "../shared/project-info-queries.js";

/** Rust framework rules — web frameworks and ORMs via Cargo.toml. */
export const rustFrameworkRules: readonly FrameworkRule[] = [
  {
    id: "axum",
    name: "Axum",
    check: (info) => hasCargoDep(info, "axum"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "actix-web",
    name: "Actix Web",
    check: (info) => hasCargoDep(info, "actix-web"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "rocket",
    name: "Rocket",
    check: (info) => hasCargoDep(info, "rocket"),
    detectedVia: "Cargo.toml dependency",
  },
  // ORMs
  {
    id: "diesel",
    name: "Diesel",
    check: (info) => hasCargoDep(info, "diesel"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "sea-orm",
    name: "SeaORM",
    check: (info) => hasCargoDep(info, "sea-orm"),
    detectedVia: "Cargo.toml dependency",
  },
  {
    id: "rust-sqlx",
    name: "SQLx (Rust)",
    check: (info) => hasCargoDep(info, "sqlx") && !hasCargoDep(info, "sea-orm"),
    detectedVia: "Cargo.toml dependency",
  },
];
