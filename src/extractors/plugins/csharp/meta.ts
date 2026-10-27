import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";
import { extractCsharpScheduledJobs } from "./scheduled-jobs.js";
import { extractAspireResources } from "./aspire.js";
import { extractCsharpTypeAliases } from "./type-aliases.js";
import { extractCsharpNamespace } from "./namespace.js";
import { csharpTaint } from "./taint.js";
import { yarpForwarders } from "./forwarders.js";
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
import { CSharpDataSourceExtractor, extractCsharpPathArgCalls } from "./data-sources.js";
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
import { csharpGrpcStub, csharpGrpcService } from "../shared/grpc-stubs.js";
import { hotChocolateResolver } from "./graphql.js";

export const csharpMeta: LanguagePluginMeta = {
  securityRules: CSHARP_SECURITY_RULES,
  securityPostScan: csharpSecurityPostScan,
  // Dead-code reachability (see reachability.ts).
  reachability: csharpReachability,
  ...csharpManifest,
  docComments: C_STYLE_DOCS,
  // `.csx` scripts: blank `#r`/`#load`, restore them as imports.
  preprocess: preprocessCsharpScript,
  routes: csharpRouteExtractor,
  functionsClasses: new CSharpExtractor(),
  importsExports: new CSharpImportExportExtractor(),
  dataSources: new CSharpDataSourceExtractor(),
  entities: new CSharpEntityExtractor(),
  dispatchResolvers: [new CSharpMediatrResolver(), new CsharpUiBridgeResolver()],
  routeResolvers: [aspnetControllerInheritance, hotChocolateResolver],
  requestSchema: csharpRequestSchema,
  grpcStubService: csharpGrpcStub,
  grpcServiceOf: csharpGrpcService,
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
    typeAliases: (tree) => extractCsharpTypeAliases(tree),
    // `namespace League.Clubs;` — what a `using League.Clubs;` elsewhere names.
    packageName: (tree) => extractCsharpNamespace(tree),
    // A .NET Aspire AppHost: the resources it runs, under the names service discovery gives them.
    deployedResources: (_tree, sourceText) => extractAspireResources(sourceText),
    // `AddHttpClient<T>(c => c.BaseAddress = …)`, named clients, `_http.BaseAddress = …`.
    httpClientRegistrations: extractCsharpHttpClientRegistrations,
    proxyRules: (_tree, sourceText, filePath) => yarpForwarders(sourceText, filePath),
    // `Program.cs` top-level statements → the `<setup>` pseudo-function's locals.
    topLevelLocalTypes: (tree) => extractCsharpTopLevelLocalTypes(tree.rootNode),
    // `await Get<T>(uri)` on a helper that requests its `uri` parameter: the path each call hands over.
    // Gated on a string holding a `/` — a file without one names no path.
    pathArgCalls: (tree, sourceText) => (/"[^"\n]*\/[^"\n]*"/.test(sourceText) ? extractCsharpPathArgCalls(tree, sourceText) : []),
    // Hangfire recurring jobs and Quartz.NET jobs: entry points a clock runs.
    entryPoints: (_tree, sourceText) => extractCsharpScheduledJobs(sourceText),
  },
  calls: csharpCallHooks,
};
