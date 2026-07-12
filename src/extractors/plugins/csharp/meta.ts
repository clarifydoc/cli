import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractCsharpTypeReferences } from "./type-references.js";
import { csharpCallHooks } from "./call-hooks.js";
import { nugetPackages } from "./packages.js";
import { csharpFrameworkRules } from "./frameworks.js";
import { extractWinFormsInteractiveElements, extractWinFormsScreens } from "./winforms-ui.js";

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
  // xUnit/NUnit/MSTest: `FooTest.cs`, `FooTests.cs` (PascalCase, case-sensitive).
  testFilePatterns: [/(Test|Tests)\.cs$/],
  grammar: {
    variants: { csharp: { pkg: "tree-sitter-c-sharp", wasm: "tree-sitter-c_sharp.wasm" } },
  },
  builtinTypes: CSHARP_BUILTINS,
  knownPackages: nugetPackages,
  frameworkRules: csharpFrameworkRules,
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
    // WinForms wiring (`X.Click += Handler;`) — Designer files AND hand-wired
    // forms; the partial-class handler link is added by CsharpUiBridgeResolver.
    interactiveElements: (_tree, sourceText) => extractWinFormsInteractiveElements(sourceText),
    screens: (_tree, sourceText, filePath) => extractWinFormsScreens(sourceText, filePath),
  },
  calls: csharpCallHooks,
};
