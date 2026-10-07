import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { dartFrameworkRules } from "./frameworks.js";
import { pubPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const dartManifest: LanguagePluginManifest = {
  language: "dart",
  family: "dart",
  packageManagers: [pubPackageManager],
  packageEcosystems: ["pub"],
  parsing: "regex",
  extensions: [".dart"],
  // One type spans files here: `part` files and `extension`s add to a type from other files.
  typesSpanFiles: true,
  testFilePatterns: [/_test\.dart$/],
  // build_runner output: json_serializable, freezed, riverpod, injectable.
  generatedFilePatterns: [/\.g\.dart$/, /\.freezed\.dart$/, /\.gr\.dart$/, /\.config\.dart$/],
  externalNamespaceRoots: ["dart", "package"],
  frameworkImportHints: { "package:flutter": "flutter", "package:go_router": "go_router", "package:http": "http", "package:dio": "dio", "package:cloud_firestore": "firestore", "package:sqflite": "sqflite", "package:supabase_flutter": "supabase", "package:shelf": "shelf", "package:shelf_router": "shelf" },
  frameworkRules: dartFrameworkRules,
  activationFiles: ["pubspec.yaml"],
};
