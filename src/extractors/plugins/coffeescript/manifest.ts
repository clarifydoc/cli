import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const coffeeManifest: LanguagePluginManifest = {
  language: "coffeescript",
  // JavaScript's family: `require './x'` reaches `.js` and `.coffee` alike.
  family: "script",
  // Compiled to JavaScript and installed from npm (package.json — javascript's manager).
  packageEcosystems: ["npm"],
  parsing: "regex",
  extensions: [".coffee", ".litcoffee"],
  testFilePatterns: [/[-_.](?:spec|test)\.(?:lit)?coffee$/, /(?:^|\/)(?:test|spec)s?\/.*\.(?:lit)?coffee$/],
  frameworkImportHints: { express: "express", backbone: "backbone", hubot: "hubot" },
};
