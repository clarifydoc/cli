import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { vSpec } from "./index.js";
import { vManifest } from "./manifest.js";
import { vReachability } from "./reachability.js";
import { blankVNonCode, foreignVFile } from "./source.js";
import { extractVSqlSources } from "./data-sources.js";

const V_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "i8", "i16", "i32", "i64", "u8", "u16", "u32", "u64", "f32", "f64", "isize", "usize", "rune", "voidptr", "byteptr",
  "charptr", "map", "chan", "thread", "IError", "Error", "Result", "Context",
]);

export const vMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: vReachability,
  ...vManifest,
  regexSpec: vSpec,
  builtinTypes: V_BUILTINS,
  // Verilog and Coq `.v` files are refused; comments and multi-line strings
  // are blanked; the SQL in strings is read afterwards from the raw source.
  preprocess(rawSource, relativePath) {
    const foreign = foreignVFile(rawSource, relativePath);
    if (foreign) return { skip: foreign };
    return {
      sourceText: blankVNonCode(rawSource),
      language: "vlang",
      postExtract(analysis, raw) {
        const sql = extractVSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
};
