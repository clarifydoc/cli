import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { bashManifest } from "./manifest.js";
import { bashCallHooks } from "./call-hooks.js";
import { BashFunctionExtractor } from "./functions.js";
import { BashImportExtractor } from "./imports.js";
import { BashDataSourceExtractor } from "./data-sources.js";
import { bashReachability } from "./reachability.js";

export const bashMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: bashReachability,
  ...bashManifest,
  functionsClasses: new BashFunctionExtractor(),
  importsExports: new BashImportExtractor(),
  dataSources: new BashDataSourceExtractor(),
  calls: bashCallHooks,
  // HTTP clients are classified by name, so a project function never
  // captures `curl` by name. (Database clients are read as data access by
  // data-sources.ts; DB roots only classify dotted names.)
  apiCallRoots: ["curl", "wget", "http", "https"],
  complexity: {
    branchNodes: new Set(["if_statement", "elif_clause", "while_statement", "for_statement", "c_style_for_statement", "case_item", "ternary_expression"]),
    logicalOps: new Set(["&&", "||"]),
    nestingNodes: new Set(["subshell", "command_substitution"]),
    logicalOpNodes: new Set(["list"]),
  },
};
