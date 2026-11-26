import { phpServiceConfig } from "./service-config.js";
import { phpCollectionElement } from "./collection-element.js";
import { phpMigrationFiles } from "./migration-files.js";
import { phpProjectCommands } from "./project-commands.js";
import { phpTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { phpFrameworkRules, phpMarkerCandidates } from "./frameworks.js";
import { composerPackageManager } from "./package-manifests.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts and package-manifests.ts only.
 */
export const phpManifest: LanguagePluginManifest = {
  docComments: C_STYLE_DOCS,
  migrationFiles: phpMigrationFiles,
  testCommand: phpTestCommand,
  projectCommands: phpProjectCommands,
  language: "php",
  collectionElementOf: phpCollectionElement,
  callPathsFromHead: true,
  family: "php",
  // A userland function ignores arguments past its parameters; too few is the error.
  callArity: { extraAllowed: true },
  packageManagers: [composerPackageManager],
  serviceConfig: phpServiceConfig,
  packageEcosystems: ["composer"],
  parsing: "tree-sitter",
  // `.inc`: the include files older PHP keeps its code in (`include "db.inc"`); one with no PHP in it is refused (meta.ts).
  extensions: [".php", ".inc"],
  // A field is only reached through the instance (`this.x`); a bare name never is one.
  explicitSelfMembers: true,
  // `$this->writeUTF()` calls the declared `writeUtf`; `$Repo` is still not `$repo`.
  caseInsensitiveCallables: true,
  // `require 'lib/db.php'` puts the included file's functions in scope.
  importsShareScope: true,
  // A class head binds only through the calling file's evidence — a class declared there, an import naming it (its
  // alias or a namespace prefix), the file's own `declaredNamespace`, or a fully qualified name, which keeps its
  // backslashes in the call name (`\App\Other\Garage.park`); the unique-global guess never re-links a head so
  // refused. A `use` names the class declared in exactly that namespace (`ClassInfo.namespace`) wherever its PSR-4
  // directory sits. A free function in a namespace says so in `declaredNamespace`, so `use function`, `\\App\\fn()` and
  // same-namespace calls join on it; a file opening several namespaces records each class's own
  // `ClassInfo.namespace` and each function's `FunctionInfo.namespace` (the `filesNamedByEvidence` lookup).
  classNamesByEvidence: { separator: "\\" },
  grammar: { variants: { php: { pkg: "tree-sitter-php", wasm: "tree-sitter-php.wasm" } } },
  testFilePatterns: [/(Test|TestCase)\.php$/],
  testSubjectAffixes: { suffixes: ["TestCase", "Test"] },
  externalModulePrefixes: ["Illuminate\\", "Symfony\\", "Doctrine\\", "Laravel\\"],
  frameworkImportHints: { "Doctrine\\ORM": "doctrine", "Illuminate\\Database": "eloquent", "Illuminate\\Database\\Eloquent": "eloquent", Propel: "propel", "Propel\\Runtime": "propel", "Envms\\FluentPDO": "fluentpdo" },
  frameworkRules: phpFrameworkRules,
  markerCandidates: phpMarkerCandidates,
  activationFiles: ["composer.json"],
  // Files that mark a sub-project root (core's project detector); a lower `priority` wins a directory holding several kinds.
  projectMarkers: [
    { pattern: "**/composer.json", kind: "php", priority: 130 },
  ],
};
