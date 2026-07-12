import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";
import { rubygemsPackages } from "./packages.js";
import { rubyManifest } from "./manifest.js";
import { RubyEntityExtractor } from "./entities.js";

export const rubyMeta: LanguagePluginMeta = {
  ...rubyManifest,
  regexSpec: rubySpec,
  knownPackages: rubygemsPackages,
  entities: new RubyEntityExtractor(),
  builtinTypes: new Set(COMMON_PRIMITIVES),
  complexity: {
    branchNodes: new Set([
      "if", "unless", "while", "until", "for", "case",
      "when", "rescue",
    ]),
    logicalOps: new Set(["&&", "||", "and", "or"]),
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call", "method_call"]) },
};
