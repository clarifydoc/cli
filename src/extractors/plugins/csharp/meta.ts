import { csharpTaint } from "./taint.js";
import type { LanguagePluginMeta } from "../../../types/language-plugin.js";
import {
  extendControlFlow,
  BRACE_REGEX_CONTROL_FLOW,
} from "../../shared/control-flow-defaults.js";
import { CSHARP_BUILTINS } from "./builtins.js";
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
import { aspnetControllerInheritance } from "./routes/aspnet-resolver.js";
import { CSharpMediatrResolver } from "./dispatch.js";
import { CsharpUiBridgeResolver } from "./ui-bridge.js";
import { csharpRequestSchema } from "./request-schema.js";
import { csharpReachability } from "./reachability.js";
import { extractCsharpDiBindings } from "./di-bindings.js";
import { extractCsharpHttpClientRegistrations } from "./http-clients.js";
import { extractCsharpTopLevelLocalTypes } from "./local-types.js";
import { preprocessCsharpScript } from "./script.js";
import { CSHARP_SECURITY_RULES, csharpSecurityPostScan } from "./security-rules.js";
import { csharpGrpcStub } from "../shared/grpc-stubs.js";

export const csharpMeta: LanguagePluginMeta = {
  securityRules: CSHARP_SECURITY_RULES,
  securityPostScan: csharpSecurityPostScan,
  // Dead-code reachability (see reachability.ts).
  reachability: csharpReachability,
  ...csharpManifest,
  // `.csx` scripts: blank `#r`/`#load`, restore them as imports.
  preprocess: preprocessCsharpScript,
  routes: csharpRouteExtractor,
  functionsClasses: new CSharpExtractor(),
  importsExports: new CSharpImportExportExtractor(),
  dataSources: new CSharpDataSourceExtractor(),
  entities: new CSharpEntityExtractor(),
  dispatchResolvers: [new CSharpMediatrResolver(), new CsharpUiBridgeResolver()],
  routeResolvers: [aspnetControllerInheritance],
  requestSchema: csharpRequestSchema,
  grpcStubService: csharpGrpcStub,
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
    // Request input followed to a dangerous call inside each request handler.
    taint: csharpTaint,
    typeReferences: extractCsharpTypeReferences,
    // WinForms wiring (`X.Click += Handler;`) — Designer files AND hand-wired
    // forms; the partial-class handler link is added by CsharpUiBridgeResolver.
    interactiveElements: (_tree, sourceText) => extractWinFormsInteractiveElements(sourceText),
    screens: (_tree, sourceText, filePath) => extractWinFormsScreens(sourceText, filePath),
    // `services.AddScoped<IRepo, SqlRepo>()`, Autofac `RegisterType<T>().As<I>()`, …
    diBindings: (tree, sourceText) => extractCsharpDiBindings(tree, sourceText),
    // `AddHttpClient<T>(c => c.BaseAddress = …)`, named clients, `_http.BaseAddress = …`.
    httpClientRegistrations: extractCsharpHttpClientRegistrations,
    // `Program.cs` top-level statements → the `<setup>` pseudo-function's locals.
    topLevelLocalTypes: (tree) => extractCsharpTopLevelLocalTypes(tree.rootNode),
  },
  calls: csharpCallHooks,
};
