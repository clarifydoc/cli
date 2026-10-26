import { HASH_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rManifest } from "./manifest.js";
import { rCallHooks } from "./call-hooks.js";
import { RExtractor } from "./functions-classes.js";
import { RImportExportExtractor } from "./imports-exports.js";
import { RDataSourceExtractor } from "./data-sources.js";
import { rRouteExtractor } from "./routes.js";
import { rReachability } from "./reachability.js";
import { cranPackages } from "./packages.js";
import { extractShinyInteractions, extractShinyScreens } from "./shiny.js";

export const rMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: rReachability,
  ...rManifest,
  docComments: HASH_DOCS,
  functionsClasses: new RExtractor(),
  importsExports: new RImportExportExtractor(),
  dataSources: new RDataSourceExtractor(),
  routes: rRouteExtractor,
  knownPackages: cranPackages,
  builtinTypes: new Set([...COMMON_PRIMITIVES, "character", "numeric", "integer", "logical", "data.frame", "list", "environment", "function"]),
  apiCallRoots: ["httr", "httr2", "curl"],
  dbCallRoots: ["DBI"],
  complexity: {
    branchNodes: new Set(["if_statement", "for_statement", "while_statement", "repeat_statement"]),
    logicalOps: new Set(["&&", "||", "&", "|"]),
    logicalOpNodes: new Set(["binary_operator"]),
    nestingNodes: new Set(["function_definition"]),
  },
  ast: {
    // Shiny: the UI page as a screen, and the server's observers as what its inputs do.
    screens: (tree, sourceText, filePath) => extractShinyScreens(tree, sourceText, filePath),
    interactiveElements: (tree, sourceText) => extractShinyInteractions(tree, sourceText),
  },
  calls: rCallHooks,
};
