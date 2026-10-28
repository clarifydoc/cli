import { rubyMigrationFiles } from "./migration-files.js";
import { rubyProjectCommands } from "./project-commands.js";
import { rubyTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { rubyFrameworkRules } from "./frameworks.js";
import { rubygemsPackageManager } from "./package-manifests.js";
import { rubyAutoloadedFiles, rubyTypeNamedByReceiver } from "./autoload.js";
import { resolveRubyRequire } from "./require-paths.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and the other leaf rules it imports.
 */
export const rubyManifest: LanguagePluginManifest = {
  migrationFiles: rubyMigrationFiles,
  testCommand: rubyTestCommand,
  projectCommands: rubyProjectCommands,
  language: "ruby",
  family: "ruby",
  // `Foo.new(…)` runs `initialize`.
  constructorCalls: ["new"],
  importsNameDirectories: true,
  // `require "league"` loads `league.rb` from the load path (require-paths.ts).
  resolveImport: resolveRubyRequire,
  // Rails loads a constant from the file its name spells: the constants a file names are its imports.
  autoloadedFiles: rubyAutoloadedFiles,
  typeNamedByReceiver: rubyTypeNamedByReceiver,
  packageManagers: [rubygemsPackageManager],
  packageEcosystems: ["rubygems"],
  parsing: "regex",
  extensions: [".rb", ".rake", ".jbuilder"],
  // One type spans files here: a class can be reopened in another file of its namespace.
  typesSpanFiles: true,
  testFilePatterns: [/_(spec|test)\.rb$/],
  externalModulePrefixes: ["rails", "active_record", "active_support", "action_controller", "rspec", "bundler", "rake"],
  frameworkImportHints: { active_record: "active-record", sequel: "sequel" },
  frameworkRules: rubyFrameworkRules,
  activationFiles: ["Gemfile"],
};
