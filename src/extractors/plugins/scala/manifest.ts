import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { sbtPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const scalaManifest: LanguagePluginManifest = {
  language: "scala",
  family: "jvm",
  packageManagers: [sbtPackageManager],
  packageEcosystems: ["maven"],
  parsing: "regex",
  // `.sc`: Scala CLI / Ammonite scripts, worksheets and Mill's `build.sc`
  // (SuperCollider also writes `.sc` — meta.ts skips those).
  extensions: [".scala", ".sc"],
  testFilePatterns: [/Spec\.scala$/, /Test\.scala$/, /\/src\/test\//],
  // Without these an sbt module is not a sub-project, so every Scala file in a
  // multi-module build lands in the enclosing repo's bucket.
  activationFiles: ["build.sbt", "build.sc"],
  // Play's routes table has no extension; the route extractor dispatches on its basename.
  namedFiles: ["routes"],
  externalModulePrefixes: ["scala.", "java.", "javax.", "akka.", "cats.", "zio.", "play.", "org.apache.", "io.circe", "doobie.", "slick."],
  frameworkImportHints: { "slick.": "slick", "doobie.": "doobie", "io.getquill": "quill" },
};
