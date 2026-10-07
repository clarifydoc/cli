import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { haxeSpec } from "./index.js";
import { haxeManifest } from "./manifest.js";
import { haxeReachability } from "./reachability.js";
import { HaxeEntityExtractor } from "./entities.js";

export const haxeMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: haxeReachability,
  ...haxeManifest,
  regexSpec: haxeSpec,
  entities: new HaxeEntityExtractor(),
  builtinTypes: new Set([...COMMON_PRIMITIVES, "Int", "Float", "Bool", "String", "Void", "Dynamic", "Array", "Map", "Null", "Any", "Date", "Promise", "SId", "SString", "SInt", "SFloat", "SBool", "SDateTime"]),
};
