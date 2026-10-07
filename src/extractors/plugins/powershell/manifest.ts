import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { psgalleryPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const powershellManifest: LanguagePluginManifest = {
  language: "powershell",
  family: "powershell",
  packageManagers: [psgalleryPackageManager],
  packageEcosystems: ["psgallery"],
  parsing: "regex",
  // `.psd1` module manifests are data — read by the inventory and reachability, not analyzed.
  extensions: [".ps1", ".psm1"],
  // PowerShell is case-insensitive: `get-user` calls `Get-User`.
  caseInsensitiveNames: true,
  // Dot-sourcing and Import-Module put a file's functions in scope by name.
  importsShareScope: true,
  testFilePatterns: [/\.Tests\.ps1$/i],
  externalModulePrefixes: ["Microsoft.PowerShell", "System", "Az.", "AWS.Tools"],
  frameworkImportHints: { Pode: "pode", Polaris: "polaris", Pester: "pester" },
};
