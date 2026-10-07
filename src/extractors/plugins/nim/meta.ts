import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { nimSpec, nimImports } from "./index.js";
import { nimManifest } from "./manifest.js";
import { nimReachability } from "./reachability.js";
import { nimblePackages } from "./packages.js";
import { blankNimNonCode } from "./source.js";
import { extractNimSqlSources } from "./data-sources.js";

const NIM_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "int8", "int16", "int32", "int64", "uint", "uint8", "uint16", "uint32", "uint64", "float32", "float64", "char",
  "cstring", "cint", "cuint", "clong", "cfloat", "cdouble", "csize_t", "Natural", "Positive", "pointer", "seq",
  "array", "set", "openArray", "varargs", "range", "typedesc", "untyped", "typed", "auto", "tuple", "Table",
  "TableRef", "OrderedTable", "HashSet", "Option", "Future", "JsonNode", "RootObj", "RootRef", "Exception",
  "CatchableError", "ValueError", "IOError", "OSError", "KeyError",
]);

export const nimMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: nimReachability,
  ...nimManifest,
  regexSpec: nimSpec,
  knownPackages: nimblePackages,
  builtinTypes: NIM_BUILTINS,
  // Block comments and multi-line strings are blanked for extraction;
  // imports and the SQL in strings are read afterwards (SQL from the raw source).
  preprocess(rawSource) {
    const sourceText = blankNimNonCode(rawSource);
    return {
      sourceText,
      language: "nim",
      postExtract(analysis, raw) {
        analysis.imports = nimImports(splitLines(sourceText));
        const sql = extractNimSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
};
