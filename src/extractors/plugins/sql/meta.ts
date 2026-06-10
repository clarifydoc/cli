import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { sqlSpec } from "./index.js";

export const sqlMeta: LanguagePluginMeta = {
  language: "sql",
  parsing: "regex",
  extensions: sqlSpec.extensions,
  regexSpec: sqlSpec,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
