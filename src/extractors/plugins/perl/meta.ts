import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { perlSpec } from "./index.js";
import { cpanPackages } from "./packages.js";
import { perlManifest } from "./manifest.js";

export const perlMeta: LanguagePluginMeta = {
  ...perlManifest,
  regexSpec: perlSpec,
  knownPackages: cpanPackages,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
