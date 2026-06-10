import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { rubySpec } from "./index.js";

export const rubyMeta: LanguagePluginMeta = {
  language: "ruby",
  parsing: "regex",
  extensions: rubySpec.extensions,
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
};
