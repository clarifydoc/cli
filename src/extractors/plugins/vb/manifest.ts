import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const vbManifest: LanguagePluginManifest = {
  language: "vb",
  parsing: "regex",
  extensions: [".vb", ".bas", ".cls", ".frm"],
  // VB is case-insensitive: `_repo.save` calls the declared `Save`.
  caseInsensitiveNames: true,
  // One type spans files here: `Partial Class` splits one type across files.
  typesSpanFiles: true,
  externalNamespaceRoots: ["System", "Microsoft"],
  // WinForms designers, the VB counterpart of the C# rule above.
  generatedFilePatterns: [/\.Designer\.vb$/],
};
