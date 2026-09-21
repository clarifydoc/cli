import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendRegexControlFlow } from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { cSpec } from "./index.js";
import { cManifest } from "./manifest.js";

export const C_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "char", "signed", "unsigned", "size_t", "ssize_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "intptr_t", "uintptr_t", "FILE", "NULL",
]);

export const cMeta: LanguagePluginMeta = {
  // C: the brace defaults, plus `goto` drawn as the jump it is.
  regexControlFlow: extendRegexControlFlow([{ match: /^goto\b/, type: "break_statement" }]),
  ...cManifest,
  regexSpec: cSpec,
  builtinTypes: C_BUILTINS,
};
