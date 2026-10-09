import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { shardsPackageManager } from "./package-manifests.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types and package-manifests.ts only.
 */
export const crystalManifest: LanguagePluginManifest = {
  language: "crystal",
  family: "crystal",
  // `Foo.new(…)` runs `initialize`.
  constructorCalls: ["new"],
  packageManagers: [shardsPackageManager],
  packageEcosystems: ["shards"],
  parsing: "regex",
  extensions: [".cr"],
  // A required file's top-level methods and types join one program: a
  // class can be reopened, and a `def` in one file is called by name in another.
  importsShareScope: true,
  typesSpanFiles: true,
  testFilePatterns: [/_spec\.cr$/, /(?:^|\/)spec\//],
  frameworkImportHints: { kemal: "kemal", amber: "amber", lucky: "lucky", athena: "athena", marten: "marten", granite: "granite", jennifer: "jennifer", avram: "avram" },
  activationFiles: ["shard.yml"],
};
