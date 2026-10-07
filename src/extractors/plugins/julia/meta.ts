import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { juliaManifest } from "./manifest.js";
import { juliaCallHooks } from "./call-hooks.js";
import { JuliaExtractor } from "./functions-classes.js";
import { JuliaImportExportExtractor } from "./imports-exports.js";
import { JuliaDataSourceExtractor } from "./data-sources.js";
import { juliaRouteExtractor } from "./routes.js";
import { juliaReachability } from "./reachability.js";

export const juliaMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: juliaReachability,
  ...juliaManifest,
  functionsClasses: new JuliaExtractor(),
  importsExports: new JuliaImportExportExtractor(),
  dataSources: new JuliaDataSourceExtractor(),
  routes: juliaRouteExtractor,
  builtinTypes: new Set([...COMMON_PRIMITIVES, "Int", "Int64", "Int32", "Float64", "Float32", "Bool", "String", "Symbol", "Char", "Nothing", "Any", "Vector", "Matrix", "Array", "Dict", "Tuple", "NamedTuple", "Union", "Missing"]),
  apiCallRoots: ["HTTP"],
  complexity: {
    branchNodes: new Set(["if_statement", "elseif_clause", "for_statement", "while_statement", "ternary_expression", "catch_clause"]),
    logicalOps: new Set(["&&", "||"]),
    logicalOpNodes: new Set(["binary_expression"]),
    nestingNodes: new Set(["function_definition", "arrow_function_expression", "do_clause"]),
  },
  calls: juliaCallHooks,
};
