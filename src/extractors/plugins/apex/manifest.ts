import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types only.
 */
export const apexManifest: LanguagePluginManifest = {
  docComments: C_STYLE_DOCS,
  language: "apex",
  // Java-like, but its classes live in the organisation's one namespace and call nothing a JVM library offers.
  family: "apex",
  parsing: "regex",
  extensions: [".trigger"],
  // `.cls` is VB6's extension and `.xml` is Spring XML's: this plugin's `adopt` reads the Apex classes and the SFDX
  // object and field metadata among them.
  adoptsSuffixes: [".cls", ".object-meta.xml", ".field-meta.xml"],
  caseInsensitiveNames: true,
  testFilePatterns: [/(?:[a-z0-9]Tests?|_[Tt]ests?)\.(?:cls|trigger)$/],
  testSubjectAffixes: { suffixes: ["Test", "_Test", "Tests"] },
  activationFiles: ["sfdx-project.json"],
};
