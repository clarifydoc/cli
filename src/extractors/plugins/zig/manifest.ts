import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { zigPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types and package-manifests.ts only.
 */
export const zigManifest: LanguagePluginManifest = {
  language: "zig",
  family: "zig",
  packageManagers: [zigPackageManager],
  packageEcosystems: ["zig"],
  parsing: "tree-sitter",
  extensions: [".zig"],
  grammar: { variants: { zig: { pkg: "@tree-sitter-grammars/tree-sitter-zig", wasm: "tree-sitter-zig.wasm" } } },
  testFilePatterns: [/(?:^|\/)tests?\/.*\.zig$/],
  // Distinctive names only: hints apply to every language (`pg` is also node-postgres).
  frameworkImportHints: { zap: "zap", httpz: "httpz", jetzig: "jetzig", tokamak: "tokamak" },
  activationFiles: ["build.zig.zon", "build.zig"],
};
