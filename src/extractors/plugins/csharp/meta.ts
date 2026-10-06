import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import {
  extendControlFlow,
  BRACE_REGEX_CONTROL_FLOW,
} from "../../shared/control-flow-defaults.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractCsharpTypeReferences } from "./type-references.js";
import { csharpCallHooks } from "./call-hooks.js";
import { nugetPackages } from "./packages.js";
import { csharpManifest } from "./manifest.js";
import { extractWinFormsInteractiveElements, extractWinFormsScreens } from "./winforms-ui.js";
import { CSharpExtractor } from "./functions-classes.js";
import { CSharpImportExportExtractor } from "./imports-exports.js";
import { CSharpDataSourceExtractor } from "./data-sources.js";
import { CSharpEntityExtractor } from "./entities.js";
import { csharpRouteExtractor } from "./routes/aspnet.js";
import { CSharpMediatrResolver } from "./dispatch.js";
import { CsharpUiBridgeResolver } from "./ui-bridge.js";
import { csharpRequestSchema } from "./request-schema.js";
import { csharpReachability } from "./reachability.js";

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
  // Dead-code reachability (see reachability.ts).
  reachability: csharpReachability,
  ...csharpManifest,
  routes: csharpRouteExtractor,
  functionsClasses: new CSharpExtractor(),
  importsExports: new CSharpImportExportExtractor(),
  dataSources: new CSharpDataSourceExtractor(),
  entities: new CSharpEntityExtractor(),
  dispatchResolvers: [new CSharpMediatrResolver(), new CsharpUiBridgeResolver()],
  requestSchema: csharpRequestSchema,
  builtinTypes: CSHARP_BUILTINS,
  knownPackages: nugetPackages,
  complexity: {
    branchNodes: new Set([
      "if_statement", "while_statement", "for_statement", "foreach_statement",
      "catch_clause", "case_switch_label", "conditional_expression",
    ]),
    logicalOps: new Set(["&&", "||", "??"]),
    nestingNodes: new Set(["lambda_expression", "anonymous_method_expression", "local_function_statement"]),
  },
  // The C-family defaults already cover C#'s statements (and its `update`
  // field, which TypeScript spells `increment`); what it adds is the member
  // declarations the body resolver has to recognise as "a function starts
  // here", and the expression-bodied member form.
  regexControlFlow: BRACE_REGEX_CONTROL_FLOW,
  controlFlow: extendControlFlow([
    ["method_declaration", "nested-function"],
    ["constructor_declaration", "nested-function"],
    ["destructor_declaration", "nested-function"],
    ["operator_declaration", "nested-function"],
    ["accessor_declaration", "nested-function"],
    ["arrow_expression_clause", "wrapper"],
  ]),
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
