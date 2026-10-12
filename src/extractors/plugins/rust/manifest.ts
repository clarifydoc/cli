import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { rustFrameworkRules } from "./frameworks.js";
import { cargoPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const rustManifest: LanguagePluginManifest = {
  language: "rust",
  family: "rust",
  importsNameDirectories: true,
  packageManagers: [cargoPackageManager],
  packageEcosystems: ["cargo"],
  parsing: "regex",
  extensions: [".rs"],
  // One type spans files here: `impl` blocks for a type can live in other files of its module.
  typesSpanFiles: true,
  // `let m = upgrade_manager(x)?;` holds the `Ok` value: `?`/`.unwrap()` unwrap these
  // as an await unwraps a task (`*Result` = a project alias such as `FlowyResult<T>`).
  asyncResultTypes: ["Result", "Option", "*Result"],
  externalModulePrefixes: ["std::", "core::", "alloc::", "serde", "tokio", "actix", "rocket", "hyper", "reqwest", "diesel", "sqlx"],
  frameworkImportHints: { diesel: "diesel", sea_orm: "sea-orm", sqlx: "rust-sqlx" },
  frameworkRules: rustFrameworkRules,
  activationFiles: ["Cargo.toml"],
};
