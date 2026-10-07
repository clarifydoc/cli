import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { rakuSpec } from "./index.js";
import { rakuManifest } from "./manifest.js";
import { rakuPackages } from "./packages.js";
import { rakuReachability } from "./reachability.js";
import { blankRakuProse, extractRakuSqlSources } from "./data-sources.js";

export const rakuMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: rakuReachability,
  ...rakuManifest,
  // Heredoc bodies and Pod are blanked for extraction (prose and SQL are no
  // code); SQL is read from the raw source afterwards.
  preprocess(rawSource) {
    return {
      sourceText: blankRakuProse(rawSource) ?? rawSource,
      language: "raku",
      postExtract(analysis, raw) {
        const sql = extractRakuSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
  regexSpec: rakuSpec,
  knownPackages: rakuPackages,
  builtinTypes: new Set([...COMMON_PRIMITIVES, "Str", "Int", "UInt", "Num", "Rat", "Bool", "Any", "Mu", "Cool", "Array", "Hash", "List", "Map", "Seq", "Promise", "Supply", "Callable", "Code", "Block", "Pair", "Nil", "IO::Path"]),
  complexity: {
    branchNodes: new Set(["if", "elsif", "unless", "while", "until", "for", "loop", "when", "with", "orwith", "CATCH"]),
    logicalOps: new Set(["&&", "||", "and", "or", "//"]),
  },
};
