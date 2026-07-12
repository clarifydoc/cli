import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { goSpec } from "./index.js";
import { goPackages } from "./packages.js";
import { goManifest } from "./manifest.js";
import { GoEntityExtractor } from "./entities.js";

const GO_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
  "float32", "float64", "complex64", "complex128",
  "byte", "rune", "string", "bool", "error",
  "any", "comparable",
  "map", "chan", "interface",
]);

export const goMeta: LanguagePluginMeta = {
  ...goManifest,
  regexSpec: goSpec,
  builtinTypes: GO_BUILTINS,
  knownPackages: goPackages,
  entities: new GoEntityExtractor(),
  complexity: {
    branchNodes: new Set([
      "if_statement", "for_statement", "expression_switch_statement",
      "type_switch_statement", "select_statement", "case_clause",
    ]),
    logicalOps: new Set(["&&", "||"]),
  },
  // Call node types for when a tree-sitter grammar is wired up.
  calls: { callNodeTypes: new Set(["call_expression", "composite_literal"]) },
};
