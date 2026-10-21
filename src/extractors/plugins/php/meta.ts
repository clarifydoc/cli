import { extractPhpScheduledJobs } from "./scheduled-jobs.js";
import { phpTaint } from "./taint.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendControlFlow } from "../../shared/control-flow-defaults.js";
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
import { phpRequestSchema } from "./request-schema.js";
import { phpReachability } from "./reachability.js";
import { phpDiBindings } from "./di.js";
import { PHP_SECURITY_RULES } from "./security-rules.js";
import { extractPhpPathArgCalls } from "./path-arg-calls.js";

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
  securityRules: PHP_SECURITY_RULES,
  // Dead-code reachability (see reachability.ts).
  reachability: phpReachability,
  ...phpManifest,
  routes: phpRouteExtractor,
  functionsClasses: new PhpExtractor(),
  importsExports: new PhpImportExportExtractor(),
  dataSources: new PhpDataSourceExtractor(),
  dataMutations: new PhpMutationExtractor(),
  entities: new PhpEntityExtractor(),
  builtinTypes: PHP_BUILTINS,
  requestSchema: phpRequestSchema,
  knownPackages: composerPackages,
  complexity: {
    branchNodes: new Set([
      "if_statement", "while_statement", "for_statement", "foreach_statement",
      "switch_case", "catch_clause",
    ]),
    logicalOps: new Set(["&&", "||", "??"]),
    nestingNodes: new Set(["anonymous_function", "anonymous_function_creation_expression", "arrow_function"]),
  },
  // PHP is C-family with its own vocabulary: the block is a
  // `compound_statement`, an `if`'s then-branch is its `body` (the shared
  // field aliases cover that), and an `elseif` chain is flattened onto the
  // parent `if` as repeated `alternative` fields, the way Python does it.
  controlFlow: extendControlFlow([
    ["compound_statement", "block"],
    ["else_if_clause", "branch"],
    ["switch_block", "block"],
    ["case_statement", "case"],
    ["default_statement", "case"],
    // PHP 8 made `throw` an expression; it is still a statement in effect.
    ["throw_expression", "throw"],
    ["anonymous_function", "nested-function"],
    ["anonymous_function_creation_expression", "nested-function"],
    ["arrow_function", "nested-function"],
    ["method_declaration", "nested-function"],
    ["function_definition", "nested-function"],
    ["function_static_declaration", "nested-function"],
  ]),
  ast: {
    // Laravel and Symfony scheduled jobs: entry points a clock runs.
    entryPoints: (_tree, sourceText) => extractPhpScheduledJobs(sourceText),
    // Request input followed to a dangerous call inside each request handler.
    taint: phpTaint,
    // Blade templates (.blade.php) surface as UI screens; interactive elements
    // are content-gated on Blade directives (the hook receives no file path).
    screens: (_tree, sourceText, filePath) => extractBladeScreens(sourceText, filePath),
    interactiveElements: (_tree, sourceText) => extractBladeInteractiveElements(sourceText),
    // Call sites of a project request wrapper (`$connection->request(Verb::GET, "/x")`).
    pathArgCalls: extractPhpPathArgCalls,
    // Laravel / Symfony / PHP-DI container registrations (see di.ts).
    diBindings: (tree, sourceText) => phpDiBindings(tree, sourceText),
    // `namespace App\Support;` — where `money()` and `use function …\money` look.
    declaredNamespace: (tree) => {
      const ns = tree.rootNode.namedChildren.find((c) => c.type === "namespace_definition");
      return ns?.childForFieldName("name")?.text ?? ns?.namedChildren.find((c) => c.type === "namespace_name")?.text ?? null;
    },
  },
  calls: phpCallHooks,
};
