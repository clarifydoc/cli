import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { VB_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 *
 * Extensions `.vb`, `.bas`, `.cls`, `.frm`, `.vbs`; `parsing: "regex"`; `family: "dotnet"`;
 * `caseInsensitiveNames: true` (`_repo.save` calls the declared `Save`); `typesSpanFiles: true` (`Partial Class`
 * splits one type across files); `packageEcosystems: ["nuget"]`; `projectMarkers` `**\/*.vbproj` (kind `dotnet`,
 * priority 30); generated files `*.Designer.vb`; `externalNamespaceRoots` `System`, `Microsoft`. Member effects:
 * Visual Basic types found only in the writer's directory (`typesSpanFiles` without `typesBeyondDirectory`) are
 * looked up as written.
 *
 * `.cls` is VB6's: the Apex plugin takes an Apex class through the manifest's `adoptsSuffixes` (`.cls`,
 * `*.object-meta.xml`, `*.field-meta.xml`) and the meta's `adopt`, so the registry's `preprocessFile` asks the
 * adopting plugin before the owner's `preprocess` (in the analyzer and in discovery's skip check); no plugin
 * imports another. A VB project loads the C# plugin (its `dispatchLanguages`) so the UI-bridge resolver runs
 * (WinForms `Handles`-style and partial-class wiring join through the language-agnostic partial-class join).
 */
export const vbManifest: LanguagePluginManifest = {
  docComments: VB_DOCS,
  language: "vb",
  overloadedMembers: true,
  family: "dotnet",
  packageEcosystems: ["nuget"],
  parsing: "regex",
  // `.vbs`: VBScript — the VB6 dialect, run statement by statement (cscript/wscript).
  extensions: [".vb", ".bas", ".cls", ".frm", ".vbs"],
  // VB is case-insensitive: `_repo.save` calls the declared `Save`.
  caseInsensitiveNames: true,
  // One type spans files here: `Partial Class` splits one type across files.
  typesSpanFiles: true,
  externalNamespaceRoots: ["System", "Microsoft"],
  // WinForms designers, the VB counterpart of the C# rule above.
  generatedFilePatterns: [/\.Designer\.vb$/],
  // Files that mark a sub-project root (core's project detector); a lower `priority` wins a directory holding several kinds.
  projectMarkers: [
    { pattern: "**/*.vbproj", kind: "dotnet", priority: 30 },
  ],
};
