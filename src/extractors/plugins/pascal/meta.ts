import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { parseDfm } from "../../../parsers/dfm-parser.js";
import { pascalCallHooks } from "./call-hooks.js";

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

const DELPHI_EXTERNAL_PREFIXES = [
  "System.", "Vcl.", "Fmx.", "Data.", "Datasnap.", "EMS.", "Winapi.", "Posix.",
  "IdHTTP", "IdTCP", "IdSSL",
];

export const pascalMeta: LanguagePluginMeta = {
  language: "pascal",
  parsing: "tree-sitter",
  extensions: [".pas", ".pp", ".lpr", ".dpr", ".dpk"],
  grammar: {
    variants: { pascal: { pkg: "tree-sitter-pascal", wasm: "tree-sitter-pascal.wasm" } },
  },
  builtinTypes: PASCAL_BUILTINS,
  externalModulePrefixes: DELPHI_EXTERNAL_PREFIXES,
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
};

/**
 * Delphi form resource files. Parsed by the dedicated DFM parser; they share
 * basenames with their .pas counterpart and are never imported by name, so
 * they are excluded from import-path resolution and security scanning.
 */
export const dfmMeta: LanguagePluginMeta = {
  language: "dfm",
  parsing: "custom",
  extensions: [".dfm"],
  importTarget: false,
  customParse: parseDfm,
  builtinTypes: PASCAL_BUILTINS,
  skipSecurityScan: true,
};
