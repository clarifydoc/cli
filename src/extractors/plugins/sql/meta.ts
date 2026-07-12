import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { sqlSpec } from "./index.js";
import { sqlManifest } from "./manifest.js";

export const sqlMeta: LanguagePluginMeta = {
  ...sqlManifest,
  regexSpec: sqlSpec,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
