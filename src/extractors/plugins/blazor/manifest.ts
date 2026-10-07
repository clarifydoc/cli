import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const blazorManifest: LanguagePluginManifest = {
  language: "blazor",
  family: "dotnet",
  parsing: "regex",
  extensions: [".razor"],
  importTarget: false,
  frameworkImportHints: { "Microsoft.AspNetCore.Components": "blazor" },
};
