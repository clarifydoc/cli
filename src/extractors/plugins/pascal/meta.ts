import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { extendControlFlow } from "../../shared/control-flow-defaults.js";
import { parseDfm } from "../../../parsers/dfm-parser.js";
import { pascalCallHooks } from "./call-hooks.js";
import { pascalManifest, dfmManifest } from "./manifest.js";
import { PascalExtractor } from "./functions-classes.js";
import { PascalImportExportExtractor } from "./imports-exports.js";
import { PascalDataSourceExtractor } from "./data-sources.js";
import { PascalMutationExtractor } from "./data-mutations.js";
import { pascalRouteExtractor } from "./routes.js";
import { PascalUiBridgeResolver } from "./ui-bridge.js";
import { dfmEntityExtractor } from "./dfm-entities.js";
import { pascalReachability } from "./reachability.js";
import { pascalDiBindings } from "./di.js";

const PASCAL_BUILTINS: ReadonlySet<string> = new Set<string>([
  "Integer", "Cardinal", "Word", "Byte", "ShortInt", "SmallInt", "LongInt",
  "Int64", "QWord",
  "Real", "Single", "Double", "Extended", "Currency",
  "Boolean", "ByteBool", "WordBool", "LongBool",
  "Char", "WideChar", "AnsiChar",
  "String", "AnsiString", "WideString", "UnicodeString", "ShortString", "RawByteString",
  "Pointer", "TObject", "TClass",
  "Variant", "OleVariant",
  "PChar", "PAnsiChar", "PWideChar",
  // Common VCL/RTL
  "TStream", "TStringList", "TStrings", "TList", "TDateTime", "Exception",
]);

export const pascalMeta: LanguagePluginMeta = {
  // Dead-code reachability (see reachability.ts).
  reachability: pascalReachability,
  ...pascalManifest,
  routes: pascalRouteExtractor,
  functionsClasses: new PascalExtractor(),
  importsExports: new PascalImportExportExtractor(),
  dataSources: new PascalDataSourceExtractor(),
  dataMutations: new PascalMutationExtractor(),
  builtinTypes: PASCAL_BUILTINS,
  complexity: {
    branchNodes: new Set([
      "ifStatement", "whileStatement", "forStatement",
      "exceptHandler", "caseItem",
    ]),
    logicalOps: new Set(["and", "or"]),
  },
  // tree-sitter-pascal keeps field names but none of the C-family spellings:
  // an `if`'s arms are `then` and `else` (covered by the shared aliases), a
  // `for` counts from `start`, and every statement type is a bare keyword
  // (`while`, `repeat`, `case`, `try`). Break/Continue/Exit are procedure
  // CALLS in Pascal, not statements, so they are drawn as ordinary steps —
  // see `unmodelled` in the graph, which says so.
  controlFlow: extendControlFlow([
    ["block", "block"],
    ["statements", "block"],
    ["ifElse", "branch"],
    ["if", "branch"],
    ["while", "loop"],
    ["for", "loop"],
    ["repeat", "post-test-loop"],
    ["case", "switch"],
    ["caseCase", "case"],
    ["caseLabel", "case-label"],
    ["caseElse", "case"],
    ["try", "try"],
    ["exceptionHandler", "catch"],
    ["defProc", "nested-function"],
    ["declProc", "ignore"],
    ["declVars", "ignore"],
    ["comment", "ignore"],
  ], {
    fields: {
      // `for I := 0 to N` counts from `start`, and a `try` calls its guarded
      // block `try` rather than `body`.
      initializer: ["start"],
      body: ["body", "try"],
    },
    // 155 of this grammar's node types are keywords (`kBegin`, `kThen`, …)
    // and they appear in statement position, so they are skipped by shape
    // rather than listed one by one.
    ignorePattern: /^k[A-Z]/,
    shapes: {
      // `defProc header=declProc local=declVars body=block`
      defProc: { body: -1 },
      // `case <discriminant> of …` names nothing; the value is child one.
      case: { value: 0 },
    },
  }),
  apiCallRoots: ["THTTPClient", "TRESTClient", "TIdHTTP"],
  dbCallRoots: ["Query", "Connection", "DataSet", "SQLQuery"],
  calls: pascalCallHooks,
  // Spring4D container registrations (see di.ts).
  ast: { diBindings: pascalDiBindings },
  dispatchResolvers: [new PascalUiBridgeResolver()],
};

/**
 * Delphi form resource files. Parsed by the dedicated DFM parser; they share
 * basenames with their .pas counterpart and are never imported by name, so
 * they are excluded from import-path resolution and security scanning.
 */
export const dfmMeta: LanguagePluginMeta = {
  ...dfmManifest,
  customParse: parseDfm,
  // Table entities are built inside `parseDfm` (it already has the object
  // tree); this registration is what gets the extractor's cross-file merge —
  // one node per physical table, not one per form — run by core.
  entities: dfmEntityExtractor,
  // Old Delphi DFMs are binary TPF0 streams; latin1 keeps every byte intact
  // for the binary→text converter (utf-8 would mangle them irreversibly).
  sourceEncoding: "latin1",
  builtinTypes: PASCAL_BUILTINS,
  skipSecurityScan: true,
};
