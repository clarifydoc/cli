import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { tclSpec } from "./index.js";
import { tclManifest } from "./manifest.js";

export const tclMeta: LanguagePluginMeta = {
  ...tclManifest,
  regexSpec: tclSpec,
  builtinTypes: new Set([...COMMON_PRIMITIVES]),
  complexity: {
    branchNodes: new Set(["if", "elseif", "while", "for", "foreach", "switch", "catch", "try"]),
    logicalOps: new Set(["&&", "||"]),
  },
};
