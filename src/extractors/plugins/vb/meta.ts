import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { vbSpec } from "./index.js";
import { vbManifest } from "./manifest.js";
import { vbRequestSchema } from "./request-schema.js";
import { vbReachability } from "./reachability.js";

const VB_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Integer", "Long", "Short", "Byte", "SByte",
  "Single", "Double", "Decimal",
  "Boolean", "Char", "String", "Date", "DateTime",
  "Object", "Nothing",
  "List", "Dictionary", "ArrayList",
  "Exception", "Variant",
]);

export const vbMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: vbReachability,
  ...vbManifest,
  regexSpec: vbSpec,
  builtinTypes: VB_BUILTINS,
  requestSchema: vbRequestSchema,
};
