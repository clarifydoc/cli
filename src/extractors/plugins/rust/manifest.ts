import { rustMigrationFiles } from "./migration-files.js";
import { rustProjectCommands } from "./project-commands.js";
import { resolveRustImport } from "./module-resolver.js";
import { rustTestCommand } from "./test-command.js";
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
  migrationFiles: rustMigrationFiles,
  resolveImport: resolveRustImport,
  testCommand: rustTestCommand,
  projectCommands: rustProjectCommands,
  language: "rust",
  family: "rust",
  // Each file in `src/bin/` is a binary crate root; the default `**/bin/**`
  // ignore (a .NET build-output directory) would otherwise skip them.
  sourceDirs: [{ dir: "src/bin", marker: "Cargo.toml" }],
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
  // The standard library's iterator, Option/Result and process-status members: a
  // project method merely sharing the name (`PropertyMap::iter`) is a coincidence.
  builtinMembers: ["iter", "iter_mut", "into_iter", "success", "is_some", "is_none", "is_ok", "is_err", "unwrap_or_default", "map_err", "ok_or", "ok_or_else", "and_then", "as_str", "to_owned", "as_ref", "as_mut", "take", "borrow", "borrow_mut", "unwrap_or_else", "cloned", "copied"],
  externalModulePrefixes: ["std::", "core::", "alloc::", "serde", "tokio", "actix", "rocket", "hyper", "reqwest", "diesel", "sqlx"],
  frameworkImportHints: { diesel: "diesel", sea_orm: "sea-orm", sqlx: "rust-sqlx" },
  frameworkRules: rustFrameworkRules,
  activationFiles: ["Cargo.toml"],
};
