import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { luaSpec } from "./index.js";
import { luaPackages } from "./packages.js";
import { luaManifest } from "./manifest.js";
import { luaReachability } from "./reachability.js";

export const luaMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: luaReachability,
  ...luaManifest,
  regexSpec: luaSpec,
  knownPackages: luaPackages,
  builtinTypes: new Set(COMMON_PRIMITIVES),
};
