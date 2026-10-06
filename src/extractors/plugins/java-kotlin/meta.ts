import type { Language } from "../../../types/analysis.js";
import { jvmRequestSchema } from "./request-schema.js";
import {
  extendControlFlow,
  BRACE_REGEX_CONTROL_FLOW,
} from "../../shared/control-flow-defaults.js";
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
import { javaKotlinReachability } from "./reachability.js";

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
  /**
   * Control-flow tables. Java and Kotlin share this factory but not their
   * grammars' shapes, so each supplies its own (or none, when its grammar
   * cannot support a graph honestly).
   */
  controlFlow?: LanguagePluginMeta["controlFlow"];
  apiCallRoots: string[];
  calls: CallExtractionHooks;
}): LanguagePluginMeta {
  return {
    ...(language === "java" ? javaManifest : kotlinManifest),
    routes: javaKotlinRouteExtractor,
    functionsClasses: jvmFunctionsClasses,
    requestSchema: jvmRequestSchema,
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
    regexControlFlow: BRACE_REGEX_CONTROL_FLOW,
    controlFlow: opts.controlFlow,
    knownPackages: jvmPackages,
    apiCallRoots: opts.apiCallRoots,
    dbCallRoots: JVM_DB_ROOTS,
    ast: {
      typeReferences: (tree, filePath) => extractJavaKotlinTypeReferences(tree, language, filePath),
    },
    calls: opts.calls,
    // ONE instance for both members: core loads it once.
    reachability: javaKotlinReachability,
  };
}

export const javaMeta: LanguagePluginMeta = jvmMeta("java", {
  builtinTypes: JAVA_BUILTINS,
  branchNodes: [
    "if_statement", "while_statement", "for_statement", "enhanced_for_statement",
    "catch_clause", "ternary_expression", "switch_block_statement_group",
  ],
  nestingNodes: ["lambda_expression"],
  // Java is the closest of any grammar here to the C-family defaults; what it
  // adds is the enhanced `for`, the `switch` spelled as an expression node
  // even in statement position, and try-with-resources.
  controlFlow: extendControlFlow([
    ["enhanced_for_statement", "loop"],
    ["switch_expression", "switch"],
    ["switch_block", "block"],
    ["switch_block_statement_group", "case"],
    ["switch_label", "case-label"],
    ["switch_rule", "case"],
    ["try_with_resources_statement", "try"],
    ["resource_specification", "ignore"],
    ["synchronized_statement", "wrapper"],
    ["lambda_expression", "nested-function"],
    ["method_declaration", "nested-function"],
    ["constructor_declaration", "nested-function"],
    ["compact_constructor_declaration", "nested-function"],
    ["static_initializer", "nested-function"],
    ["line_comment", "ignore"],
    ["block_comment", "ignore"],
  ]),
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
  // tree-sitter-kotlin names no fields at all and writes every jump as one
  // `jump_expression`, so this spec leans on both escape hatches: `shapes` for
  // which named child is the condition and which is the body, and `jumpRoles`
  // for which keyword a jump carries.
  controlFlow: extendControlFlow(
    [
      ["statements", "block"],
      ["control_structure_body", "wrapper"],
      ["function_body", "wrapper"],
      ["if_expression", "branch"],
      ["while_statement", "loop"],
      ["for_statement", "loop"],
      ["do_while_statement", "post-test-loop"],
      ["when_expression", "switch"],
      ["when_entry", "case"],
      ["when_condition", "case-label"],
      ["when_subject", "ignore"],
      ["try_expression", "try"],
      ["catch_block", "catch"],
      ["finally_block", "finally"],
      ["jump_expression", "jump"],
      ["lambda_literal", "nested-function"],
      ["anonymous_function", "nested-function"],
      ["function_declaration", "nested-function"],
      ["getter", "nested-function"],
      ["setter", "nested-function"],
      ["line_comment", "ignore"],
      ["multiline_comment", "ignore"],
    ],
    {
      // `when` runs exactly one arm; `else ->` is its catch-all.
      fallthrough: false,
      shapes: {
        if_expression: { condition: 0, consequence: 1, alternative: 2 },
        while_statement: { condition: 0, body: -1 },
        do_while_statement: { body: 0, condition: -1 },
        for_statement: { body: -1 },
        when_expression: { value: 0 },
        when_entry: { body: -1 },
        try_expression: { body: 0 },
        catch_block: { body: -1 },
        finally_block: { body: -1 },
        // Where a declaration keeps its body, for the resolver that has to
        // find the function before it can draw anything.
        function_declaration: { body: -1 },
        getter: { body: -1 },
        setter: { body: -1 },
        anonymous_function: { body: -1 },
        lambda_literal: { body: -1 },
      },
      jumpRoles: { return: "return", break: "break", continue: "continue", throw: "throw" },
    },
  ),
  apiCallRoots: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit", "ktor"],
  calls: kotlinCallHooks,
});
