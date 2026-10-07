import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { coffeeSpec, coffeeImports, blankNonCode, coffeeSqlSources, literateCode } from "./index.js";
import { coffeeManifest } from "./manifest.js";
import { coffeeReachability } from "./reachability.js";

export const coffeeMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: coffeeReachability,
  ...coffeeManifest,
  regexSpec: coffeeSpec,
  builtinTypes: new Set(COMMON_PRIMITIVES),
  // Literate files keep only their code; block comments, heredocs and
  // heregexes are blanked; imports and the SQL in strings are read after
  // extraction (SQL from the unblanked code).
  preprocess(rawSource, relativePath) {
    const code = relativePath.toLowerCase().endsWith(".litcoffee") ? literateCode(rawSource) : rawSource;
    const sourceText = blankNonCode(code);
    return {
      sourceText,
      language: "coffeescript",
      postExtract(analysis) {
        analysis.imports = coffeeImports(sourceText.split("\n"));
        const sql = coffeeSqlSources(code.split("\n"));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
};
