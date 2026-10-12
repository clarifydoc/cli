import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";
import { rubygemsPackages } from "./packages.js";
import { rubyManifest } from "./manifest.js";
import { RubyEntityExtractor } from "./entities.js";
import { rubyReachability } from "./reachability.js";
import { railsRouteAnchor } from "./route-anchor.js";

export const rubyMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: rubyReachability,
  ...rubyManifest,
  regexSpec: rubySpec,
  knownPackages: rubygemsPackages,
  entities: new RubyEntityExtractor(),
  // Rails routes move from config/routes.rb onto the action that serves them.
  routeResolvers: [railsRouteAnchor],
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
