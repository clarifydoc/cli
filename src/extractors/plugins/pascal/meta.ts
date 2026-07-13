import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { parseDfm } from "../../../parsers/dfm-parser.js";
import { pascalCallHooks } from "./call-hooks.js";
import { pascalManifest, dfmManifest } from "./manifest.js";
import { PascalExtractor } from "./functions-classes.js";
import { PascalImportExportExtractor } from "./imports-exports.js";
import { PascalDataSourceExtractor } from "./data-sources.js";
import { PascalMutationExtractor } from "./data-mutations.js";
import { pascalRouteExtractor } from "./routes.js";
import { PascalUiBridgeResolver } from "./ui-bridge.js";

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
  apiCallRoots: ["THTTPClient", "TRESTClient", "TIdHTTP"],
  dbCallRoots: ["Query", "Connection", "DataSet", "SQLQuery"],
  calls: pascalCallHooks,
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
  // Old Delphi DFMs are binary TPF0 streams; latin1 keeps every byte intact
  // for the binary→text converter (utf-8 would mangle them irreversibly).
  sourceEncoding: "latin1",
  builtinTypes: PASCAL_BUILTINS,
  skipSecurityScan: true,
};
