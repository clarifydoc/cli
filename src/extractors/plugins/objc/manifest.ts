import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types + frameworks.ts only.
 */
export const objcManifest: LanguagePluginManifest = {
  language: "objc",
  parsing: "regex",
  extensions: [".m", ".mm"],
  // One type spans files here: categories and the `@implementation` file add to a class declared elsewhere.
  typesSpanFiles: true,
  testFilePatterns: [/Tests?\.mm?$/],
  externalModulePrefixes: ["Foundation", "UIKit", "AppKit", "CoreData", "CoreGraphics", "CoreFoundation", "QuartzCore", "AVFoundation", "MapKit", "WebKit", "Security"],
  externalNamespaceRoots: ["NS", "UI", "CG", "CA", "CF"],
};
