import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const batchManifest: LanguagePluginManifest = {
  language: "batch",
  family: "batch",
  parsing: "regex",
  extensions: [".bat", ".cmd"],
  // cmd.exe is case-insensitive: `CALL :Build` reaches `:build`.
  caseInsensitiveNames: true,
};
