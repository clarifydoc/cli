import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { cSpec } from "./index.js";

export const C_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "char", "signed", "unsigned", "size_t", "ssize_t", "ptrdiff_t",
  "int8_t", "int16_t", "int32_t", "int64_t",
  "uint8_t", "uint16_t", "uint32_t", "uint64_t",
  "intptr_t", "uintptr_t", "FILE", "NULL",
]);

export const cMeta: LanguagePluginMeta = {
  language: "c",
  parsing: "regex",
  extensions: cSpec.extensions,
  regexSpec: cSpec,
  builtinTypes: C_BUILTINS,
};
