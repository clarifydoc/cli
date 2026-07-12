import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { phpCallHooks } from "./call-hooks.js";
import { composerPackages } from "./packages.js";
import { extractBladeScreens, extractBladeInteractiveElements } from "./blade.js";

const PHP_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "float", "bool", "string", "array", "iterable", "callable",
  "mixed", "never", "false", "true",
  "self", "static", "parent",
  "Exception", "Throwable", "Error", "TypeError",
  "stdClass", "Closure", "Generator", "Traversable",
  "ArrayAccess", "Countable", "Iterator", "IteratorAggregate",
]);

export const phpMeta: LanguagePluginMeta = {
  language: "php",
  parsing: "tree-sitter",
  extensions: [".php"],
  // PHPUnit: `FooTest.php`, `FooTestCase.php`.
  testFilePatterns: [/(Test|TestCase)\.php$/],
  grammar: {
    variants: { php: { pkg: "tree-sitter-php", wasm: "tree-sitter-php.wasm" } },
  },
  builtinTypes: PHP_BUILTINS,
  knownPackages: composerPackages,
  externalModulePrefixes: ["Illuminate\\", "Symfony\\", "Doctrine\\", "Laravel\\"],
  complexity: {
    branchNodes: new Set([
      "if_statement", "while_statement", "for_statement", "foreach_statement",
      "switch_case", "catch_clause",
    ]),
    logicalOps: new Set(["&&", "||", "??"]),
  },
  frameworkImportHints: {
    "Doctrine\\ORM": "doctrine",
    "Illuminate\\Database": "eloquent",
    "Illuminate\\Database\\Eloquent": "eloquent",
    "Propel": "propel",
    "Propel\\Runtime": "propel",
    "Envms\\FluentPDO": "fluentpdo",
  },
  ast: {
    // Blade templates (.blade.php) surface as UI screens; interactive elements
    // are content-gated on Blade directives (the hook receives no file path).
    screens: (_tree, sourceText, filePath) => extractBladeScreens(sourceText, filePath),
    interactiveElements: (_tree, sourceText) => extractBladeInteractiveElements(sourceText),
  },
  calls: phpCallHooks,
};
