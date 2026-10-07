import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { mojoSpec } from "./index.js";
import { mojoManifest } from "./manifest.js";
import { mojoReachability } from "./reachability.js";

export const mojoMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: mojoReachability,
  ...mojoManifest,
  regexSpec: mojoSpec,
  builtinTypes: new Set([...COMMON_PRIMITIVES, "Int", "UInt", "Int8", "Int16", "Int32", "Int64", "UInt8", "UInt32", "UInt64", "Float32", "Float64", "Bool", "String", "StringLiteral", "StringRef", "List", "Dict", "Optional", "SIMD", "DType", "PythonObject", "Self", "NoneType", "Error"]),
};
