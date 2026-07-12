import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { phpCallHooks } from "./call-hooks.js";
import { composerPackages } from "./packages.js";
import { extractBladeScreens, extractBladeInteractiveElements } from "./blade.js";
import { phpManifest } from "./manifest.js";
import { PhpExtractor } from "./functions-classes.js";
import { PhpImportExportExtractor } from "./imports-exports.js";
import { PhpDataSourceExtractor } from "./data-sources.js";
import { PhpMutationExtractor } from "./data-mutations.js";
import { PhpEntityExtractor } from "./entities.js";
import { phpRouteExtractor } from "./routes/index.js";

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
  ...phpManifest,
  routes: phpRouteExtractor,
  functionsClasses: new PhpExtractor(),
  importsExports: new PhpImportExportExtractor(),
  dataSources: new PhpDataSourceExtractor(),
  dataMutations: new PhpMutationExtractor(),
  entities: new PhpEntityExtractor(),
  builtinTypes: PHP_BUILTINS,
  knownPackages: composerPackages,
  complexity: {
    branchNodes: new Set([
      "if_statement", "while_statement", "for_statement", "foreach_statement",
      "switch_case", "catch_clause",
    ]),
    logicalOps: new Set(["&&", "||", "??"]),
  },
  ast: {
    // Blade templates (.blade.php) surface as UI screens; interactive elements
    // are content-gated on Blade directives (the hook receives no file path).
    screens: (_tree, sourceText, filePath) => extractBladeScreens(sourceText, filePath),
    interactiveElements: (_tree, sourceText) => extractBladeInteractiveElements(sourceText),
  },
  calls: phpCallHooks,
};
