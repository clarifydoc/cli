import { rubyMigrationFiles } from "./migration-files.js";
import { rubyProjectCommands } from "./project-commands.js";
import { rubyTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { rubyFrameworkRules } from "./frameworks.js";
import { rubygemsPackageManager } from "./package-manifests.js";
import { rubyAutoloadedFiles, rubyLexicalConstants, rubyModelFinders, rubyTypeNamedByReceiver } from "./autoload.js";
import { resolveRubyRequire } from "./require-paths.js";
import { HASH_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and the other leaf rules it imports.
 */
export const rubyManifest: LanguagePluginManifest = {
  docComments: HASH_DOCS,
  migrationFiles: rubyMigrationFiles,
  testCommand: rubyTestCommand,
  projectCommands: rubyProjectCommands,
  language: "ruby",
  callPathsFromHead: true,
  family: "ruby",
  // A gem's or app's executables (`bin/club`); `bin/` is .NET build output elsewhere.
  // A Gemfile alone may only serve tooling: it makes `bin/` source beside an `app/` or `lib/`.
  sourceDirs: [{ dir: "bin", marker: "Gemfile", requiresAnyOf: ["app", "lib"] }, { dir: "bin", marker: "*.gemspec" }],
  shebangInterpreter: /^ruby\d*(?:\.\d+)*$/,
  // `Foo.new(…)` runs `initialize`.
  constructorCalls: ["new"],
  importsNameDirectories: true,
  // `require "league"` loads `league.rb` from the load path (require-paths.ts).
  resolveImport: resolveRubyRequire,
  // Rails loads a constant from the file its name spells: the constants a file names are its imports.
  autoloadedFiles: rubyAutoloadedFiles,
  // `Helper` inside a compact `class League::Report` is `::Helper`, never `League::Helper`.
  lexicalConstants: rubyLexicalConstants,
  // `require`d files' top-level constants (`SERVICE = ClubService.new`) are global once loaded.
  moduleBindingsFollowImports: true,
  typeNamedByReceiver: rubyTypeNamedByReceiver,
  // `Club.find(id)` is a Club, `Club.where(…)` a query of Clubs (ActiveRecord).
  selfTypedMembers: rubyModelFinders,
  // On a receiver nothing types, these are ActiveRecord's (`players.find_by(…)`), not the one class that defines the name.
  untypedReceiverMembers: [
    ...rubyModelFinders.members, ...rubyModelFinders.queries,
    "update", "update!", "update_all", "update_attribute", "update_attributes", "update_columns", "destroy", "destroy!", "destroy_all",
    "delete", "delete_all", "save", "save!", "reload", "count", "exists?", "pluck", "find_each", "find_in_batches", "build", "new_record?", "persisted?",
  ],
  // `valid?` and `save!` are names of their own.
  marksEndNames: true,
  // `club.stadium` calls the reader `has_one :stadium` (or a `def stadium`) declares.
  parenlessMemberReads: true,
  packageManagers: [rubygemsPackageManager],
  packageEcosystems: ["rubygems"],
  parsing: "regex",
  extensions: [".rb", ".rake", ".jbuilder"],
  // One type spans files here: a class can be reopened in another file of its namespace.
  typesSpanFiles: true,
  testFilePatterns: [/_(spec|test)\.rb$/],
  testSubjectAffixes: { suffixes: ["_spec", "_test"] },
  externalModulePrefixes: ["rails", "active_record", "active_support", "action_controller", "rspec", "bundler", "rake"],
  frameworkImportHints: { active_record: "active-record", sequel: "sequel" },
  frameworkRules: rubyFrameworkRules,
  activationFiles: ["Gemfile"],
};
