import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { luaSpec } from "./index.js";

export const luaMeta: LanguagePluginMeta = {
  language: "lua",
  parsing: "regex",
  extensions: luaSpec.extensions,
  regexSpec: luaSpec,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
