import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { haskellSpec } from "./index.js";
import { hackagePackages } from "./packages.js";
import { haskellManifest } from "./manifest.js";

export const haskellMeta: LanguagePluginMeta = {
  ...haskellManifest,
  regexSpec: haskellSpec,
  builtinTypes: new Set<string>([
    ...COMMON_PRIMITIVES,
    "Int", "Integer", "Float", "Double", "Bool", "Char", "String", "Text",
    "Maybe", "Either", "Ordering", "IO", "Map", "Set", "Seq", "Vector",
    "Functor", "Applicative", "Monad", "Foldable", "Traversable", "Semigroup", "Monoid",
  ]),
  knownPackages: hackagePackages,
  apiCallRoots: ["Network.HTTP", "Req"],
  dbCallRoots: ["runDB", "runSqlPool"],
};
