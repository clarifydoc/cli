import { HASH_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";
import { rubygemsPackages } from "./packages.js";
import { rubyManifest } from "./manifest.js";
import { RubyEntityExtractor } from "./entities.js";
import { rubyReachability } from "./reachability.js";
import { railsRouteAnchor } from "./route-anchor.js";
import { RailsViewResolver } from "./rails-views.js";
import { RUBY_REGEX_CONTROL_FLOW } from "./control-flow.js";
import { RUBY_SECURITY_RULES } from "./security-rules.js";

export const rubyMeta: LanguagePluginMeta = {
  securityRules: RUBY_SECURITY_RULES,
  // Dead-code reachability (see reachability.ts).
  reachability: rubyReachability,
  ...rubyManifest,
  docComments: HASH_DOCS,
  regexSpec: rubySpec,
  knownPackages: rubygemsPackages,
  entities: new RubyEntityExtractor(),
  // Rails routes move from config/routes.rb onto the action that serves them.
  routeResolvers: [railsRouteAnchor],
  // An action renders its Jbuilder view by convention (see rails-views.ts).
  dispatchResolvers: [new RailsViewResolver()],
  builtinTypes: new Set(COMMON_PRIMITIVES),
  complexity: {
    branchNodes: new Set([
      "if", "unless", "while", "until", "for", "case",
      "when", "rescue",
    ]),
    logicalOps: new Set(["&&", "||", "and", "or"]),
  },
  // Control flow from source: keyword-delimited blocks (see control-flow.ts).
  regexControlFlow: RUBY_REGEX_CONTROL_FLOW,
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call", "method_call"]) },
};
