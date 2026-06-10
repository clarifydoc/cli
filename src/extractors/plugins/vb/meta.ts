import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { vbSpec } from "./index.js";

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
  language: "vb",
  parsing: "regex",
  extensions: vbSpec.extensions,
  builtinTypes: VB_BUILTINS,
  // `Imports System.Windows.Forms` must not match a local Forms/ directory.
  externalNamespaceRoots: ["System", "Microsoft"],
};
