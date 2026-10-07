import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const fortranManifest: LanguagePluginManifest = {
  language: "fortran",
  family: "fortran",
  parsing: "regex",
  // Fixed form (`.f`, `.for`, `.f77`, `.fpp`) and free form; `.F90` / `.F` (preprocessed) by case-folding.
  extensions: [".f", ".for", ".f77", ".f90", ".f95", ".f03", ".f08", ".fpp"],
  // `CALL SOLVE(X)` calls `subroutine solve`.
  caseInsensitiveNames: true,
  // `use solvers` puts every public procedure of the module in scope unqualified.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)test_[^/]*\.f\w*$/i, /_test\.f\w*$/i],
};
