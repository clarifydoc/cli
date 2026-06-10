import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { perlSpec } from "./index.js";

export const perlMeta: LanguagePluginMeta = {
  language: "perl",
  parsing: "regex",
  extensions: perlSpec.extensions,
  regexSpec: perlSpec,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
