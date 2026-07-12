import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";
import { rubygemsPackages } from "./packages.js";
import { rubyFrameworkRules } from "./frameworks.js";

export const rubyMeta: LanguagePluginMeta = {
  language: "ruby",
  parsing: "regex",
  extensions: rubySpec.extensions,
  regexSpec: rubySpec,
  knownPackages: rubygemsPackages,
  frameworkRules: rubyFrameworkRules,
  // RSpec / Minitest: `foo_spec.rb`, `foo_test.rb`.
  testFilePatterns: [/_(spec|test)\.rb$/],
  builtinTypes: new Set(COMMON_PRIMITIVES),
  externalModulePrefixes: [
    "rails", "active_record", "active_support", "action_controller",
    "rspec", "bundler", "rake",
  ],
  complexity: {
    branchNodes: new Set([
      "if", "unless", "while", "until", "for", "case",
      "when", "rescue",
    ]),
    logicalOps: new Set(["&&", "||", "and", "or"]),
  },
  frameworkImportHints: {
    "active_record": "active-record",
    "sequel": "sequel",
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call", "method_call"]) },
};
