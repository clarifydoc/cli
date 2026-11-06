import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";
import { rubygemsPackages } from "./packages.js";
import { rubyManifest } from "./manifest.js";
import { RubyEntityExtractor } from "./entities.js";
import { rubyReachability } from "./reachability.js";
import { railsRouteAnchor } from "./route-anchor.js";
import { grapeMounts } from "./grape.js";
import { RailsViewResolver } from "./rails-views.js";
import { RubyNodeRendererResolver } from "./renderer-dispatch.js";
import { RUBY_REGEX_CONTROL_FLOW } from "./control-flow.js";
import { RUBY_SECURITY_RULES } from "./security-rules.js";

export const rubyMeta: LanguagePluginMeta = {
  securityRules: RUBY_SECURITY_RULES,
  // Dead-code reachability (see reachability.ts).
  reachability: rubyReachability,
  ...rubyManifest,
  regexSpec: rubySpec,
  knownPackages: rubygemsPackages,
  entities: new RubyEntityExtractor(),
  // Rails routes move from config/routes.rb onto the action that serves them.
  // Grape APIs take the prefix, version and path of the APIs that mount them.
  routeResolvers: [railsRouteAnchor, grapeMounts],
  // An action renders its Jbuilder view by convention (see rails-views.ts).
  dispatchResolvers: [new RailsViewResolver(), new RubyNodeRendererResolver()],
  builtinTypes: new Set(COMMON_PRIMITIVES),
  // `class Scope` inside `class Policy` reaches none of Policy's instance methods.
  nestedClassesShareNothing: true,
  // A type written `League::Club` means the Club declared in `module League`, not a top-level Club.
  nestedTypePaths: true,
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
