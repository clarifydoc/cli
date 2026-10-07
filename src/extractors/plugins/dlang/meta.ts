import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { dSpec, dImports } from "./index.js";
import { dManifest } from "./manifest.js";
import { dReachability } from "./reachability.js";
import { dubPackages } from "./packages.js";
import { blankDNonCode, foreignDFile } from "./source.js";
import { extractDSqlSources } from "./data-sources.js";

const D_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "ubyte", "ushort", "uint", "ulong", "ucent", "cent", "char", "wchar", "dchar", "size_t", "ptrdiff_t", "real",
  "ifloat", "idouble", "ireal", "cfloat", "cdouble", "creal", "dstring", "wstring", "auto", "Object", "Exception",
  "Error", "Throwable", "Nullable", "Json", "Bson", "SysTime", "Duration",
]);

export const dMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: dReachability,
  ...dManifest,
  regexSpec: dSpec,
  knownPackages: dubPackages,
  builtinTypes: D_BUILTINS,
  // Make dependency files are refused; comments and the strings whose text
  // reads as code are blanked; imports and the SQL in strings are read
  // afterwards (SQL from the raw source).
  preprocess(rawSource) {
    const foreign = foreignDFile(rawSource);
    if (foreign) return { skip: foreign };
    const sourceText = blankDNonCode(rawSource);
    return {
      sourceText,
      language: "dlang",
      postExtract(analysis, raw) {
        analysis.imports = dImports(splitLines(sourceText));
        const sql = extractDSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
};
