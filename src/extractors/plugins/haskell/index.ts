import type { RegexLangSpec } from "../shared/regex-base.js";

/**
 * Haskell regex spec. Layout (indent) structured. Functions are captured from
 * their top-level type signature `name :: Type` (one per function, carries the
 * name); `data`/`newtype`/`class`/`instance` become the class concept. Imports
 * are `import [qualified] Module [as M] [(names)]`.
 */
export const haskellSpec: RegexLangSpec = {
  language: "haskell",
  extensions: [".hs", ".lhs"],
  indentBased: true,
  lineCommentPrefixes: ["--"],

  functionPatterns: [
    {
      // Top-level signature `parseConfig :: FilePath -> IO Config`.
      pattern: /^([a-z_][\w']*)\s*::/,
      isExported: () => true, // visibility is via the module export list
    },
  ],

  classPatterns: [
    { pattern: /^(?:data|newtype)\s+([A-Z][\w']*)/ },
    { pattern: /^class\s+(?:[^=>]*=>\s*)?([A-Z][\w']*)/ },
  ],

  importPatterns: [
    {
      // `import qualified Data.Map as M (foo, bar)` → source Data.Map
      pattern: /^import\s+(?:qualified\s+)?([A-Z][\w'.]*)/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split(".");
        return [parts[parts.length - 1]];
      },
    },
  ],
};
