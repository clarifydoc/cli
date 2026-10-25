import { templateEscapePreprocess } from "./template-escapes.js";
import { markupCalls } from "./markup-calls.js";
import { extractCdkResources } from "./cdk-resources.js";
import { cdkRouteResolver } from "./routes/cdk.js";
import { nestPrefixResolver } from "./routes/nestjs.js";
import { trpcRouterResolver } from "./routes/trpc.js";
import { extractEntryPoints } from "./entry-points.js";
import type { Language, SecurityIssue } from "../../../types/analysis.js";
import type { LanguagePluginMeta, SecurityRule, AstExtractorHooks } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractTsTypeReferences } from "./type-references.js";
import { extractInteractiveElements } from "./interactive-elements.js";
import { extractSubComponents } from "./sub-components.js";
import { extractJsxComponentTree } from "./component-tree.js";
import {
  extractAngularComponentTree,
  extractAngularInteractiveElements,
  extractAngularTemplateUrl,
} from "./angular-template.js";
import { extractEvents } from "./events.js";
import { extractCustomElements } from "./web-components.js";
import { extractPathReferences } from "./path-references.js";
import { javascriptCallHooks, typescriptCallHooks } from "./call-hooks.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { extractJsDiBindings } from "./di-bindings.js";
import { extractHttpClientBases, extractHttpClientRegistrations } from "./http-clients.js";
import { extractStoreModules, VuexDispatchResolver } from "./vuex.js";
import { extractDevProxyRules } from "./dev-proxies.js";
import { extractKubbConfigs } from "./kubb.js";
import { extractPathArgCalls } from "./path-arg-calls.js";
import { extractDomBindings } from "./dom-bindings.js";
import { DomBindingResolver } from "./dom-binding-resolver.js";
import { JobEventResolver } from "./job-events.js";
import { extractInstantiations } from "./instantiations.js";
import { extractModuleValues } from "./module-values.js";
import { vuePreprocess } from "./vue-hooks.js";
import { sveltePreprocess } from "./svelte-hooks.js";
import { bundlePreprocess } from "./bundles.js";
import { npmPackages } from "./packages.js";
import { typescriptManifest, javascriptManifest } from "./manifest.js";
import { DEFAULT_COMPLEXITY } from "../../shared/complexity-defaults.js";
import {
  DEFAULT_CONTROL_FLOW,
  JS_REGEX_CONTROL_FLOW,
} from "../../shared/control-flow-defaults.js";
import { JavaScriptExtractor, topLevelLocalTypes } from "./functions-classes.js";
import { extractGlobalMembers } from "./global-members.js";
import { JavaScriptImportExportExtractor } from "./imports-exports.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { JavaScriptMutationExtractor } from "./data-mutations.js";
import { JavaScriptEntityExtractor } from "./entities.js";
import { javascriptRouteExtractor } from "./routes/index.js";
import { JsComponentEmitResolver, JsPropCallbackResolver } from "./dispatch.js";
import { javascriptRequestSchema } from "./request-schema.js";
import { javascriptReachability } from "./reachability.js";
import { CREDENTIAL_CONTEXT } from "../shared/security-context.js";
import { javascriptTaint } from "./taint.js";
import { reactRouterResolver } from "./routes/react-router-resolver.js";
import { angularRouterResolver } from "./routes/angular-router-resolver.js";
import { jsGrpcStub } from "../shared/grpc-stubs.js";

const TS_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Array", "ReadonlyArray", "Map", "Set", "WeakMap", "WeakSet",
  "Promise", "PromiseLike", "Awaited",
  "Record", "Partial", "Required", "Readonly", "Pick", "Omit", "Exclude", "Extract",
  "NonNullable", "ReturnType", "InstanceType", "Parameters", "Awaited",
  "Date", "RegExp", "Error", "Function",
  "Symbol", "BigInt", "Iterable", "Iterator", "AsyncIterable", "AsyncIterator",
  "Generator", "AsyncGenerator",
  "Buffer", "ArrayBuffer", "Uint8Array", "Int32Array", "Float64Array",
  // React common types
  "ReactNode", "ReactElement", "JSX", "FC", "FunctionComponent",
  "Element", "Component", "PropsWithChildren",
  // DOM
  "HTMLElement", "HTMLInputElement", "HTMLButtonElement", "Node",
  "Event", "MouseEvent", "KeyboardEvent",
]);

// The TS/JS tables ARE the cross-language default (see complexity-defaults.ts
// and control-flow-defaults.ts) — reusing them here is what stops the default
// and the TS/JS tables from ever drifting apart.
const COMPLEXITY = DEFAULT_COMPLEXITY;
const CONTROL_FLOW = DEFAULT_CONTROL_FLOW;
// Also declared for the regex tier: a TS/JS file whose grammar failed to load
// falls back to regex extraction, and this is what lets it still be drawn. It
// doubles as the reference the regex scanner is measured against, since this
// is the one language where both tiers can be run over the same code.
const REGEX_CONTROL_FLOW = JS_REGEX_CONTROL_FLOW;

const SECURITY_RULES: readonly SecurityRule[] = [
  // Only assignments whose right-hand side has dynamic content (identifier,
  // `${…}` interpolation, or `+ identifier` concat) can inject — a static
  // literal (`el.innerHTML = ''`) can't, and `===` comparisons don't assign.
  {
    category: "xss",
    severity: "high",
    pattern: /(?:inner|outer)HTML\s*\+?=(?!=)\s*(?:[A-Za-z_$]|[^;\n]*?(?:\$\{|\+\s*[A-Za-z_$]))/,
    message: "Direct innerHTML assignment can lead to XSS. Sanitize user input.",
    priority: 20,
    excludeTest: true,
  },
  {
    category: "xss",
    severity: "high",
    pattern: /dangerouslySetInnerHTML/,
    message: "dangerouslySetInnerHTML can lead to XSS attacks. Sanitize input.",
    priority: 21,
    excludeTest: true,
  },
  {
    category: "eval-exec",
    severity: "medium",
    pattern: /new\s+Function\s*\(/,
    message: "Function constructor is similar to eval(). Consider alternatives.",
    priority: 31,
  },
  // A shell command built from values: `exec(\`git log ${ref}\`)`,
  // `execSync("rm -rf " + dir)`. The rule used to fire on every
  // `child_process` import line, `execFileSync` (no shell) and tests included.
  // `.exec(` on any other receiver is a RegExp or a query builder.
  {
    category: "command-injection",
    severity: "high",
    pattern: /(?:(?<![.\w$])|\b(?:child_process|childProcess|cp|proc|shell)\.)(?:exec|execSync)\s*\(\s*(?:`[^`]*\$\{|['"][^'"\n]*['"]\s*\+|[A-Za-z_$][\w$.]*\s*\+)/,
    message: "A shell command built from values: anything that reaches them can run commands. Pass arguments to execFile/spawn instead.",
    priority: 32,
    excludeTest: true,
  },
  {
    category: "command-injection",
    severity: "medium",
    multiline: true,
    pattern: /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\([^;]*?\bshell\s*:\s*true\b/,
    message: "A process started through a shell (shell: true): its arguments are parsed by the shell. Drop the shell or quote every value.",
    priority: 32,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-942",
    severity: "high",
    multiline: true,
    pattern: /\bcors\s*\(\s*\{[^}]*\borigin\s*:\s*(?:['"`]\*['"`]|true)[^}]*\bcredentials\s*:\s*true|\bcors\s*\(\s*\{[^}]*\bcredentials\s*:\s*true[^}]*\borigin\s*:\s*(?:['"`]\*['"`]|true)/,
    message: "CORS reflects any origin together with credentials: any site can make authenticated requests on a user's behalf.",
    priority: 33,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-295",
    severity: "high",
    pattern: /\brejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
    message: "TLS certificate verification is turned off.",
    priority: 34,
    excludeTest: true,
  },
  {
    category: "insecure-config",
    cwe: "CWE-1004",
    severity: "medium",
    pattern: /\bhttpOnly\s*:\s*false\b/,
    message: "A cookie readable from JavaScript (httpOnly: false): one XSS reads the session.",
    priority: 35,
    excludeTest: true,
  },
  {
    category: "weak-crypto",
    severity: "medium",
    pattern: new RegExp(String.raw`\bcreateHash\s*\(\s*['"\x60](?:md5|sha1|MD5|SHA1)['"\x60](?=.*${CREDENTIAL_CONTEXT})|\bcreateCipheriv?\s*\(\s*['"\x60](?:des|rc4|bf|DES|RC4|BF|[\w-]*-ecb)`),
    message: "Broken or weak cryptography (MD5/SHA-1, DES/RC4, ECB). Use SHA-256+ and AES-GCM.",
    priority: 36,
    excludeTest: true,
  },
  {
    category: "debug-statement",
    severity: "low",
    pattern: /\bdebugger\b/,
    message: "debugger statement found. Remove before production.",
    priority: 90,
  },
];

/** Flag files with more than 3 console statements (runs after the regex rules). */
function consolePostScan(lines: string[], filePath: string): SecurityIssue[] {
  const consoleLogs = lines.filter((l) => /console\.(log|debug|info)\(/.test(l));
  if (consoleLogs.length > 3) {
    return [{
      category: "debug-statement",
      severity: "low",
      message: `${consoleLogs.length} console statements found. Remove before production.`,
      filePath,
      line: lines.findIndex((l) => /console\.(log|debug|info)\(/.test(l)) + 1,
      snippet: "",
    }];
  }
  return [];
}

const API_CALL_ROOTS = ["fetch", "axios", "http", "request", "ajax", "$http", "ky", "got", "superagent", "ofetch"];
const DB_CALL_ROOTS = [
  "prisma", "mongoose", "sequelize", "knex", "typeorm", "drizzle",
  "db", "pool", "connection", "pgClient", "redis",
];

function astHooks(language: Language): AstExtractorHooks {
  return {
    taint: javascriptTaint,
    typeReferences: (tree, filePath) => extractTsTypeReferences(tree, language, filePath),
    interactiveElements: (tree, sourceText) => [
      ...extractInteractiveElements(tree, sourceText, language),
      ...extractAngularInteractiveElements(sourceText),
    ],
    subComponents: (tree, sourceText, imports) => extractSubComponents(tree, sourceText, language, imports),
    // JSX nesting (React) or, failing that, an Angular @Component inline template.
    componentTree: (tree, sourceText, imports) => {
      const jsx = extractJsxComponentTree(tree, language, imports);
      return jsx.length > 0 ? jsx : extractAngularComponentTree(sourceText);
    },
    events: (sourceText) => extractEvents(sourceText, language),
    markupCalls,
    externalTemplate: (sourceText) => extractAngularTemplateUrl(sourceText),
    customElements: (sourceText) => extractCustomElements(sourceText),
    globalMembers: (sourceText) => extractGlobalMembers(sourceText),
    httpClientBases: extractHttpClientBases,
    storeModules: extractStoreModules,
    httpClientRegistrations: extractHttpClientRegistrations,
    entryPoints: extractEntryPoints,
    // AWS CDK stacks: the queues, tables and functions they create, for the deployment model.
    deployedResources: (tree, sourceText) => extractCdkResources(tree, sourceText),
    proxyRules: extractDevProxyRules,
    generatedClients: extractKubbConfigs,
    pathArgCalls: extractPathArgCalls,
    domBindings: extractDomBindings,
    instantiations: extractInstantiations,
    moduleValues: extractModuleValues,
    pathReferences: (sourceText) => extractPathReferences(sourceText),
    variableAliases: extractJsVariableAliases,
    diBindings: extractJsDiBindings,
    topLevelLocalTypes: (tree, sourceText) => topLevelLocalTypes(tree, sourceText),
  };
}

// Domain extractors — ONE instance each, shared by the typescript and
// javascript metas (instance identity = run-once in project-level passes).
const functionsClasses = new JavaScriptExtractor();
const importsExports = new JavaScriptImportExportExtractor();
const dataSources = new JavaScriptDataSourceExtractor();
const dataMutations = new JavaScriptMutationExtractor();
const entities = new JavaScriptEntityExtractor();
const dispatchResolvers = [new JsComponentEmitResolver(), new VuexDispatchResolver(), new JsPropCallbackResolver(), new DomBindingResolver(), new JobEventResolver()];
const routeResolvers = [angularRouterResolver, reactRouterResolver, trpcRouterResolver, cdkRouteResolver, nestPrefixResolver];

export const typescriptMeta: LanguagePluginMeta = {
  ...typescriptManifest,
  routes: javascriptRouteExtractor,
  functionsClasses,
  importsExports,
  dataSources,
  dataMutations,
  entities,
  dispatchResolvers,
  routeResolvers,
  // .vue/.svelte files map to typescript; the SFC preprocess swaps in the
  // <script> block (dispatched by extension).
  preprocess: (raw, path) => vuePreprocess(raw, path) ?? sveltePreprocess(raw, path) ?? templateEscapePreprocess(raw, "typescript"),
  builtinTypes: TS_BUILTINS,
  complexity: COMPLEXITY,
  controlFlow: CONTROL_FLOW,
  regexControlFlow: REGEX_CONTROL_FLOW,
  securityRules: SECURITY_RULES,
  securityPostScan: consolePostScan,
  knownPackages: npmPackages,
  apiCallRoots: API_CALL_ROOTS,
  dbCallRoots: DB_CALL_ROOTS,
  ast: astHooks("typescript"),
  calls: typescriptCallHooks,
  requestSchema: javascriptRequestSchema,
  grpcStubService: jsGrpcStub,
  reachability: javascriptReachability,
};

export const javascriptMeta: LanguagePluginMeta = {
  ...javascriptManifest,
  routes: javascriptRouteExtractor,
  functionsClasses,
  importsExports,
  dataSources,
  dataMutations,
  entities,
  dispatchResolvers,
  routeResolvers,
  // A committed build (`public/js/app.js` from webpack) is skipped: its
  // modules are the project's own, bundled, and their facts come from the source.
  preprocess: (raw) => bundlePreprocess(raw) ?? templateEscapePreprocess(raw, "javascript"),
  builtinTypes: TS_BUILTINS,
  complexity: COMPLEXITY,
  controlFlow: CONTROL_FLOW,
  regexControlFlow: REGEX_CONTROL_FLOW,
  securityRules: SECURITY_RULES,
  securityPostScan: consolePostScan,
  knownPackages: npmPackages,
  apiCallRoots: API_CALL_ROOTS,
  dbCallRoots: DB_CALL_ROOTS,
  ast: astHooks("javascript"),
  calls: javascriptCallHooks,
  requestSchema: javascriptRequestSchema,
  grpcStubService: jsGrpcStub,
  reachability: javascriptReachability,
};
