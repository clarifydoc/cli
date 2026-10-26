import { VB_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { vbSpec } from "./index.js";
import { vbManifest } from "./manifest.js";
import { vbRequestSchema } from "./request-schema.js";
import { vbReachability } from "./reachability.js";
import { VB_REGEX_CONTROL_FLOW } from "./control-flow.js";

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
  docComments: VB_DOCS,
  regexSpec: vbSpec,
  // Control flow from source: keyword-delimited blocks (see control-flow.ts).
  regexControlFlow: VB_REGEX_CONTROL_FLOW,
  builtinTypes: VB_BUILTINS,
  requestSchema: vbRequestSchema,
};
