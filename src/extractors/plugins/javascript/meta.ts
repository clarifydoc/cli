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
import { javascriptCallHooks } from "./call-hooks.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { extractJsDiBindings } from "./di-bindings.js";
import { extractHttpClientBases, extractHttpClientRegistrations } from "./http-clients.js";
import { extractPathArgCalls } from "./path-arg-calls.js";
import { extractModuleValues } from "./module-values.js";
import { vuePreprocess } from "./vue-hooks.js";
import { sveltePreprocess } from "./svelte-hooks.js";
import { npmPackages } from "./packages.js";
import { typescriptManifest, javascriptManifest } from "./manifest.js";
import { DEFAULT_COMPLEXITY } from "../../shared/complexity-defaults.js";
import {
  DEFAULT_CONTROL_FLOW,
  JS_REGEX_CONTROL_FLOW,
} from "../../shared/control-flow-defaults.js";
import { JavaScriptExtractor } from "./functions-classes.js";
import { JavaScriptImportExportExtractor } from "./imports-exports.js";
import { JavaScriptDataSourceExtractor } from "./data-sources.js";
import { JavaScriptMutationExtractor } from "./data-mutations.js";
import { JavaScriptEntityExtractor } from "./entities.js";
import { javascriptRouteExtractor } from "./routes/index.js";
import { JsComponentEmitResolver } from "./dispatch.js";
import { javascriptRequestSchema } from "./request-schema.js";
import { javascriptReachability } from "./reachability.js";

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
  {
    category: "command-injection",
    severity: "medium",
    pattern: /child_process/,
    message: "Shell command execution detected. Ensure input is sanitized.",
    priority: 32,
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
    externalTemplate: (sourceText) => extractAngularTemplateUrl(sourceText),
    customElements: (sourceText) => extractCustomElements(sourceText),
    httpClientBases: extractHttpClientBases,
    httpClientRegistrations: extractHttpClientRegistrations,
    pathArgCalls: extractPathArgCalls,
    moduleValues: extractModuleValues,
    pathReferences: (sourceText) => extractPathReferences(sourceText),
    variableAliases: extractJsVariableAliases,
    diBindings: extractJsDiBindings,
  };
}

// Domain extractors — ONE instance each, shared by the typescript and
// javascript metas (instance identity = run-once in project-level passes).
const functionsClasses = new JavaScriptExtractor();
const importsExports = new JavaScriptImportExportExtractor();
const dataSources = new JavaScriptDataSourceExtractor();
const dataMutations = new JavaScriptMutationExtractor();
const entities = new JavaScriptEntityExtractor();
const dispatchResolvers = [new JsComponentEmitResolver()];

export const typescriptMeta: LanguagePluginMeta = {
  ...typescriptManifest,
  routes: javascriptRouteExtractor,
  functionsClasses,
  importsExports,
  dataSources,
  dataMutations,
  entities,
  dispatchResolvers,
  // .vue/.svelte files map to typescript; the SFC preprocess swaps in the
  // <script> block (dispatched by extension).
  preprocess: (raw, path) => vuePreprocess(raw, path) ?? sveltePreprocess(raw, path),
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
  calls: javascriptCallHooks,
  requestSchema: javascriptRequestSchema,
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
  reachability: javascriptReachability,
};
