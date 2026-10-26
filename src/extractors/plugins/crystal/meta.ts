import { HASH_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { crystalSpec } from "./index.js";
import { crystalManifest } from "./manifest.js";
import { shardsPackages } from "./packages.js";
import { crystalReachability } from "./reachability.js";
import { CrystalEntityExtractor } from "./entities.js";
import { blankHeredocs, extractCrystalSqlSources } from "./data-sources.js";

export const crystalMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: crystalReachability,
  ...crystalManifest,
  docComments: HASH_DOCS,
  // Heredoc bodies are blanked for extraction (an SQL block is no code, and
  // its indentation would end the block around it); their SQL is read from
  // the raw source afterwards, as is SQL in ordinary strings.
  preprocess(rawSource) {
    return {
      sourceText: blankHeredocs(rawSource) ?? rawSource,
      language: "crystal",
      postExtract(analysis, raw) {
        const sql = extractCrystalSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
  regexSpec: crystalSpec,
  knownPackages: shardsPackages,
  entities: new CrystalEntityExtractor(),
  builtinTypes: new Set([
    ...COMMON_PRIMITIVES, "String", "Int8", "Int16", "Int32", "Int64", "Int128", "UInt8", "UInt16", "UInt32", "UInt64",
    "Float32", "Float64", "Bool", "Char", "Symbol", "Nil", "Array", "Hash", "Set", "Tuple", "NamedTuple", "Time",
    "Bytes", "Slice", "Proc", "Pointer", "UUID", "JSON::Any", "YAML::Any", "Primary32", "Primary64",
  ]),
  complexity: {
    branchNodes: new Set(["if", "unless", "elsif", "while", "until", "case", "when", "in", "rescue"]),
    logicalOps: new Set(["&&", "||"]),
  },
};
