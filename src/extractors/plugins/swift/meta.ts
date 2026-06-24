import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { swiftSpec } from "./index.js";
import { swiftPackages } from "./packages.js";

const SWIFT_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Int8", "Int16", "Int32", "Int64",
  "UInt", "UInt8", "UInt16", "UInt32", "UInt64",
  "Float", "Double", "Bool", "Character",
  "String", "Substring",
  "Array", "Set", "Dictionary",
  "Optional", "Result",
  "Error", "Any", "AnyObject",
  "Void",
]);

export const swiftMeta: LanguagePluginMeta = {
  language: "swift",
  parsing: "regex",
  extensions: swiftSpec.extensions,
  regexSpec: swiftSpec,
  knownPackages: swiftPackages,
  builtinTypes: SWIFT_BUILTINS,
};
