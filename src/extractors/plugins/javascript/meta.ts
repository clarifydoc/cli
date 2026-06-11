import type { Language, SecurityIssue } from "../../../types/analysis.js";
import type { LanguagePluginMeta, SecurityRule, AstExtractorHooks } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { NOISE_CALLS } from "../../shared/call-graph.js";
import { extractTsTypeReferences } from "./type-references.js";
import { extractInteractiveElements } from "./interactive-elements.js";
import { extractSubComponents } from "./sub-components.js";
import { extractEvents } from "./events.js";
import { javascriptCallHooks } from "./call-hooks.js";
import { extractJsVariableAliases } from "./variable-aliases.js";
import { vuePreprocess } from "./vue-hooks.js";

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

const COMPLEXITY = {
  branchNodes: new Set([
    "if_statement", "while_statement", "for_statement", "for_in_statement",
    "switch_case", "catch_clause", "ternary_expression",
  ]),
  logicalOps: new Set(["&&", "||", "??"]),
};

const SECURITY_RULES: readonly SecurityRule[] = [
  {
    category: "xss",
    severity: "high",
    pattern: /innerHTML\s*=/,
    message: "Direct innerHTML assignment can lead to XSS. Sanitize user input.",
    priority: 20,
  },
  {
    category: "xss",
    severity: "high",
    pattern: /dangerouslySetInnerHTML/,
    message: "dangerouslySetInnerHTML can lead to XSS attacks. Sanitize input.",
    priority: 21,
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

/** npm import source → framework id (shared by the ts and js metas). */
const NPM_FRAMEWORK_HINTS: Readonly<Record<string, string>> = {
  "react": "react",
  "react-dom": "react",
  "react-router": "react-router",
  "react-router-dom": "react-router",
  "next": "nextjs",
  "next/router": "nextjs",
  "next/navigation": "nextjs",
  "vue": "vue",
  "vue-router": "vue-router",
  "nuxt": "nuxt",
  "pinia": "pinia",
  "vuex": "vuex",
  "express": "express",
  "@nestjs/common": "nestjs",
  "@nestjs/core": "nestjs",
  "fastify": "fastify",
  "@angular/core": "angular",
  "@angular/router": "angular",
  "react-redux": "react-redux",
  "@reduxjs/toolkit": "redux",
  "@tanstack/react-query": "react-query",
  // ORM imports
  "@prisma/client": "prisma",
  "prisma": "prisma",
  "typeorm": "typeorm",
  "sequelize": "sequelize",
  "sequelize-typescript": "sequelize",
  "drizzle-orm": "drizzle",
  "@mikro-orm/core": "mikro-orm",
  "mongoose": "mongoose",
  "knex": "knex",
  "objection": "objection",
};

/**
 * Prototype members of core JS builtins (Array/Set/Map/String/Object/Promise/
 * RegExp/Date/JSON). A call like `seen.add(x)` or `s.toUpperCase()` must never
 * be linked to a project method that happens to share the name. Built on the
 * shared NOISE_CALLS set (extraction-side noise filter) — both lists describe
 * the same "ubiquitous JS member names" domain and must not drift apart.
 */
const JS_BUILTIN_MEMBERS = [...new Set([
  ...NOISE_CALLS,
  // Set/Map/collections
  "add", "delete", "has", "get", "set", "clear",
  // Array
  "slice", "splice", "concat", "reduceRight", "findIndex", "findLast",
  "findLastIndex", "includes", "indexOf", "lastIndexOf",
  "flat", "flatMap", "fill", "sort", "reverse", "at", "copyWithin",
  // String
  "toUpperCase", "toLowerCase", "toLocaleUpperCase", "toLocaleLowerCase",
  "charAt", "charCodeAt", "codePointAt", "normalize", "trim", "trimStart",
  "trimEnd", "padStart", "padEnd", "startsWith", "endsWith",
  "replaceAll", "match", "matchAll", "search", "substring",
  "substr", "repeat", "localeCompare",
  // Object/Function/general
  "toLocaleString", "hasOwnProperty", "bind", "call", "apply", "assign", "freeze",
  // Iterator
  "next",
  // RegExp/Date/Number
  "test", "exec", "getTime", "toISOString", "toFixed", "toPrecision",
  // React hooks (called as `React.useState` etc. — framework, not project code)
  "useState", "useEffect", "useMemo", "useCallback", "useRef", "useContext",
  "useReducer", "useLayoutEffect", "useId", "useTransition",
])];

const API_CALL_ROOTS = ["fetch", "axios", "http", "request", "ajax", "$http", "ky", "got", "superagent", "ofetch"];
const DB_CALL_ROOTS = [
  "prisma", "mongoose", "sequelize", "knex", "typeorm", "drizzle",
  "db", "pool", "connection", "pgClient", "redis",
];

function astHooks(language: Language): AstExtractorHooks {
  return {
    typeReferences: (tree, filePath) => extractTsTypeReferences(tree, language, filePath),
    interactiveElements: (tree, sourceText) => extractInteractiveElements(tree, sourceText, language),
    subComponents: (tree, sourceText, imports) => extractSubComponents(tree, sourceText, language, imports),
    events: (sourceText) => extractEvents(sourceText, language),
    variableAliases: extractJsVariableAliases,
  };
}

export const typescriptMeta: LanguagePluginMeta = {
  language: "typescript",
  parsing: "tree-sitter",
  extensions: [".ts", ".tsx", ".vue"],
  grammar: {
    variants: {
      typescript: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-typescript.wasm" },
      tsx: { pkg: "tree-sitter-typescript", wasm: "tree-sitter-tsx.wasm" },
    },
    keyForFile: (filePath) =>
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx") ? "tsx" : "typescript",
  },
  // .vue files map to typescript; the SFC preprocess swaps in the <script> block.
  preprocess: vuePreprocess,
  builtinTypes: TS_BUILTINS,
  complexity: COMPLEXITY,
  securityRules: SECURITY_RULES,
  securityPostScan: consolePostScan,
  frameworkImportHints: NPM_FRAMEWORK_HINTS,
  apiCallRoots: API_CALL_ROOTS,
  dbCallRoots: DB_CALL_ROOTS,
  builtinMembers: JS_BUILTIN_MEMBERS,
  ast: astHooks("typescript"),
  calls: javascriptCallHooks,
};

export const javascriptMeta: LanguagePluginMeta = {
  language: "javascript",
  parsing: "tree-sitter",
  extensions: [".js", ".jsx", ".mjs", ".cjs"],
  grammar: {
    variants: {
      javascript: { pkg: "tree-sitter-javascript", wasm: "tree-sitter-javascript.wasm" },
    },
  },
  builtinTypes: TS_BUILTINS,
  complexity: COMPLEXITY,
  securityRules: SECURITY_RULES,
  securityPostScan: consolePostScan,
  frameworkImportHints: NPM_FRAMEWORK_HINTS,
  apiCallRoots: API_CALL_ROOTS,
  dbCallRoots: DB_CALL_ROOTS,
  builtinMembers: JS_BUILTIN_MEMBERS,
  ast: astHooks("javascript"),
  calls: javascriptCallHooks,
};
