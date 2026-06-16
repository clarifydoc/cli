import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractCsharpTypeReferences } from "./type-references.js";
import { csharpCallHooks } from "./call-hooks.js";

const CSHARP_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int16", "Int32", "Int64", "UInt16", "UInt32", "UInt64",
  "Single", "Double", "Decimal",
  "List", "Dictionary", "HashSet", "Queue", "Stack",
  "IEnumerable", "ICollection", "IList", "IDictionary", "ISet",
  "Task", "ValueTask", "Action", "Func",
  "String", "StringBuilder",
  "DateTime", "DateTimeOffset", "TimeSpan", "Guid",
  "Exception", "ArgumentException", "InvalidOperationException",
  "Tuple", "ValueTuple", "Nullable",
  // ASP.NET common
  "IActionResult", "ActionResult", "IServiceCollection",
]);

export const csharpMeta: LanguagePluginMeta = {
  language: "csharp",
  parsing: "tree-sitter",
  extensions: [".cs"],
  grammar: {
    variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } },
  },
  builtinTypes: CSHARP_BUILTINS,
  externalModulePrefixes: ["System", "Microsoft.", "Newtonsoft."],
  externalNamespaceRoots: ["System", "Microsoft"],
  complexity: {
    branchNodes: new Set([
      "if_statement", "while_statement", "for_statement", "foreach_statement",
      "catch_clause", "case_switch_label", "conditional_expression",
    ]),
    logicalOps: new Set(["&&", "||", "??"]),
  },
  frameworkImportHints: {
    "Microsoft.EntityFrameworkCore": "ef-core",
    "System.Data.Entity": "ef6",
    "Dapper": "dapper",
    "NHibernate": "nhibernate",
    "RepoDb": "repodb",
    "PetaPoco": "petapoco",
  },
  apiCallRoots: ["HttpClient", "WebClient", "RestClient"],
  dbCallRoots: ["DbContext", "DbSet", "SqlCommand", "SqlConnection"],
  ast: {
    typeReferences: extractCsharpTypeReferences,
  },
  calls: csharpCallHooks,
};
