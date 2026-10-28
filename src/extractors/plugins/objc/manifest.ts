import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const objcManifest: LanguagePluginManifest = {
  language: "objc",
  family: "cfam",
  packageEcosystems: ["swiftpm", "cocoapods"],
  parsing: "regex",
  // Read by the `tree-sitter:objc` front end only (meta.treeSitter).
  grammar: { variants: { objc: { pkg: "tree-sitter-objc", wasm: "tree-sitter-objc.wasm" } } },
  extensions: [".m", ".mm"],
  // One type spans files here: categories and the `@implementation` file add to a class declared elsewhere.
  typesSpanFiles: true,
  // `#import "Club.h"` puts the C functions `Club.h` declares in scope; `Club.m` holds their bodies.
  importsShareScope: true,
  declarationExtensions: [".h"],
  testFilePatterns: [/Tests?\.mm?$/],
  externalModulePrefixes: ["Foundation", "UIKit", "AppKit", "CoreData", "CoreGraphics", "CoreFoundation", "QuartzCore", "AVFoundation", "MapKit", "WebKit", "Security"],
  externalNamespaceRoots: ["NS", "UI", "CG", "CA", "CF"],
};
