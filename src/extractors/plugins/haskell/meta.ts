import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { haskellSpec } from "./index.js";
import { hackagePackages } from "./packages.js";

export const haskellMeta: LanguagePluginMeta = {
  language: "haskell",
  parsing: "regex",
  extensions: haskellSpec.extensions,
  regexSpec: haskellSpec,
  testFilePatterns: [/Spec\.hs$/, /Test\.hs$/],
  builtinTypes: new Set<string>([
    ...COMMON_PRIMITIVES,
    "Int", "Integer", "Float", "Double", "Bool", "Char", "String", "Text",
    "Maybe", "Either", "Ordering", "IO", "Map", "Set", "Seq", "Vector",
    "Functor", "Applicative", "Monad", "Foldable", "Traversable", "Semigroup", "Monoid",
  ]),
  knownPackages: hackagePackages,
  externalModulePrefixes: [
    "Data.", "Control.", "System.", "GHC.", "Text.", "Network.", "Prelude",
  ],
  frameworkImportHints: {
    "Yesod": "yesod",
    "Servant": "servant",
    "Web.Scotty": "scotty",
    "Database.Persist": "persistent",
  },
  apiCallRoots: ["Network.HTTP", "Req"],
  dbCallRoots: ["runDB", "runSqlPool"],
};
