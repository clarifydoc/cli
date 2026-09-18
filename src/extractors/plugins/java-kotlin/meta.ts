import type { Language } from "../../../types/analysis.js";
import type { LanguagePluginMeta, CallExtractionHooks } from "../../../types/language-plugin.js";
import { javaManifest, kotlinManifest } from "./manifest.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractJavaKotlinTypeReferences } from "./type-references.js";
import { javaCallHooks, kotlinCallHooks } from "./call-hooks.js";
import { jvmPackages } from "./packages.js";
import { JavaKotlinExtractor } from "./functions-classes.js";
import { JavaKotlinImportExportExtractor } from "./imports-exports.js";
import { JavaKotlinDataSourceExtractor } from "./data-sources.js";
import { JavaKotlinMutationExtractor } from "./data-mutations.js";
import { JavaKotlinEntityExtractor } from "./entities.js";
import { javaKotlinRouteExtractor } from "./routes/index.js";

const JAVA_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "var", "T", "E", "K", "V",
  "Integer", "Long", "Short", "Byte", "Float", "Double", "Character", "Boolean",
  "List", "ArrayList", "LinkedList",
  "Map", "HashMap", "TreeMap", "LinkedHashMap",
  "Set", "HashSet", "TreeSet", "LinkedHashSet",
  "Collection", "Iterable", "Iterator", "Stream", "Optional",
  "String", "StringBuilder", "StringBuffer",
  "Exception", "RuntimeException", "Throwable", "Error",
  "Object", "Class", "Comparable", "Comparator",
  "Date", "LocalDate", "LocalDateTime", "Instant", "Duration",
  // Spring framework common
  "ResponseEntity", "RequestEntity", "HttpStatus",
]);

const KOTLIN_BUILTINS: ReadonlySet<string> = new Set<string>([
  ...COMMON_PRIMITIVES,
  "Int", "Long", "Short", "Byte", "Float", "Double", "Char",
  "List", "MutableList", "Set", "MutableSet", "Map", "MutableMap",
  "Array", "IntArray", "LongArray", "ByteArray",
  "String", "CharSequence", "Sequence",
  "Pair", "Triple", "Result",
  "Unit", "Throwable", "Exception", "Any", "Nothing",
  "Iterable", "Iterator", "Collection",
]);

const JVM_DB_ROOTS = ["JdbcTemplate", "entityManager", "session", "repository"];

// Domain extractors — ONE instance each, shared by the java and kotlin metas
// (instance identity = run-once in project-level passes).
const jvmFunctionsClasses = new JavaKotlinExtractor();
const jvmImportsExports = new JavaKotlinImportExportExtractor();
const jvmDataSources = new JavaKotlinDataSourceExtractor();
const jvmDataMutations = new JavaKotlinMutationExtractor();
const jvmEntities = new JavaKotlinEntityExtractor();

function jvmMeta(language: Language, opts: {
  builtinTypes: ReadonlySet<string>;
  branchNodes: string[];
  /** Lambda / nested-function node types that deepen cognitive nesting. */
  nestingNodes: string[];
  apiCallRoots: string[];
  calls: CallExtractionHooks;
}): LanguagePluginMeta {
  return {
    ...(language === "java" ? javaManifest : kotlinManifest),
    routes: javaKotlinRouteExtractor,
    functionsClasses: jvmFunctionsClasses,
    importsExports: jvmImportsExports,
    dataSources: jvmDataSources,
    dataMutations: jvmDataMutations,
    entities: jvmEntities,
    builtinTypes: opts.builtinTypes,
    complexity: {
      branchNodes: new Set(opts.branchNodes),
      logicalOps: new Set(["&&", "||"]),
      nestingNodes: new Set(opts.nestingNodes),
    },
    knownPackages: jvmPackages,
    apiCallRoots: opts.apiCallRoots,
    dbCallRoots: JVM_DB_ROOTS,
    ast: {
      typeReferences: (tree, filePath) => extractJavaKotlinTypeReferences(tree, language, filePath),
    },
    calls: opts.calls,
  };
}

export const javaMeta: LanguagePluginMeta = jvmMeta("java", {
  builtinTypes: JAVA_BUILTINS,
  branchNodes: [
    "if_statement", "while_statement", "for_statement", "enhanced_for_statement",
    "catch_clause", "ternary_expression", "switch_block_statement_group",
  ],
  nestingNodes: ["lambda_expression"],
  apiCallRoots: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit"],
  calls: javaCallHooks,
});

export const kotlinMeta: LanguagePluginMeta = jvmMeta("kotlin", {
  builtinTypes: KOTLIN_BUILTINS,
  branchNodes: [
    "if_expression", "while_statement", "for_statement",
    "catch_block", "when_entry",
  ],
  nestingNodes: ["lambda_literal", "anonymous_function"],
  apiCallRoots: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit", "ktor"],
  calls: kotlinCallHooks,
});
