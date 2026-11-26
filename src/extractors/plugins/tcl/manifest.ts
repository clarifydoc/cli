import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { HASH_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY. The heavy body (meta.ts and everything it imports) is loaded lazily;
 * this module must stay a leaf: types only.
 */
export const tclManifest: LanguagePluginManifest = {
  docComments: HASH_DOCS,
  language: "tcl",
  family: "tcl",
  parsing: "regex",
  // `.tcl` scripts and `.tm` modules. Expect (`.exp`) and Tcl-embedded templates are other formats.
  extensions: [".tcl", ".tm"],
  // `source helpers.tcl` runs the file in the caller's scope: its procs are the caller's by bare name.
  importsShareScope: true,
  testFilePatterns: [/(?:^|\/)tests?\//, /\.test\.tcl$/],
  testSubjectAffixes: { suffixes: ["_test"] },
};
