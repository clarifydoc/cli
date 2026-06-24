import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { scalaSpec } from "./index.js";
import { scalaPackages } from "./packages.js";

const SCALA_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Long", "Short", "Byte", "Float", "Double", "Boolean", "Char",
  "List", "Seq", "Vector", "Array", "Map", "Set", "Option", "Some", "None",
  "Either", "Left", "Right", "Try", "Success", "Failure",
  "Future", "Promise",
  "String", "AnyVal", "AnyRef", "Nothing", "Unit",
]);

export const scalaMeta: LanguagePluginMeta = {
  language: "scala",
  parsing: "regex",
  extensions: scalaSpec.extensions,
  regexSpec: scalaSpec,
  knownPackages: scalaPackages,
  builtinTypes: SCALA_BUILTINS,
};
