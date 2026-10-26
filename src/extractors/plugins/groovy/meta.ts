import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { groovySpec } from "./index.js";
import { groovyManifest } from "./manifest.js";
import { groovyReachability } from "./reachability.js";
import { GroovyEntityExtractor } from "./entities.js";
import { blankMultilineStrings, extractGroovySqlSources } from "./data-sources.js";
import { splitLines } from "../../shared/source-lines.js";

const GROOVY_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "def", "Object", "String", "GString", "Integer", "Long", "Short", "Byte", "Double", "Float", "BigDecimal",
  "BigInteger", "Boolean", "Character", "Date", "List", "Map", "Set", "Collection", "Closure", "Range",
  "ArrayList", "HashMap", "LinkedHashMap", "HashSet", "Iterable", "Iterator", "Optional", "Exception",
  "RuntimeException", "Throwable", "void", "int", "long", "short", "byte", "double", "float", "boolean", "char",
]);

export const groovyMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: groovyReachability,
  ...groovyManifest,
  docComments: C_STYLE_DOCS,
  // Multi-line strings are blanked for extraction (an SQL block is no code);
  // their SQL is read from the raw source afterwards.
  preprocess(rawSource) {
    const sourceText = blankMultilineStrings(rawSource) ?? rawSource;
    return {
      sourceText,
      language: "groovy",
      postExtract(analysis, raw) {
        const sql = extractGroovySqlSources(splitLines(raw));
        if (sql.length > 0) analysis.dataSources = [...analysis.dataSources, ...sql].sort((a, b) => a.line - b.line);
      },
    };
  },
  regexSpec: groovySpec,
  entities: new GroovyEntityExtractor(),
  builtinTypes: GROOVY_BUILTINS,
};
