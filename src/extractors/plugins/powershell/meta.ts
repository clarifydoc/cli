import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { splitLines } from "../../shared/source-lines.js";
import { powershellSpec, powershellImports } from "./index.js";
import { powershellManifest } from "./manifest.js";
import { powershellReachability } from "./reachability.js";
import { psgalleryPackages } from "./packages.js";
import { blankPowerShellNonCode } from "./source.js";
import { extractPowerShellSqlSources } from "./data-sources.js";

const POWERSHELL_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "string", "int", "long", "bool", "double", "decimal", "datetime", "hashtable", "array", "object", "psobject",
  "pscustomobject", "scriptblock", "void", "switch", "System.String", "System.Object", "PSCredential",
]);

export const powershellMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: powershellReachability,
  ...powershellManifest,
  regexSpec: powershellSpec,
  knownPackages: psgalleryPackages,
  builtinTypes: POWERSHELL_BUILTINS,
  // Comment blocks and here-strings are blanked for extraction; imports and
  // the SQL in strings are read afterwards (SQL from the raw source).
  preprocess(rawSource) {
    const sourceText = blankPowerShellNonCode(rawSource);
    return {
      sourceText,
      language: "powershell",
      postExtract(analysis, raw) {
        analysis.imports = powershellImports(splitLines(sourceText));
        const sql = extractPowerShellSqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
};
