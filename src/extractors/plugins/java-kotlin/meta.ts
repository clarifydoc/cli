import type { Language } from "../../../types/analysis.js";
import type { LanguagePluginMeta, CallExtractionHooks } from "../../../types/language-plugin.js";
import { COMMON_PRIMITIVES } from "../../shared/builtin-types.js";
import { extractJavaKotlinTypeReferences } from "./type-references.js";
import { javaCallHooks, kotlinCallHooks } from "./call-hooks.js";
import { jvmPackages } from "./packages.js";

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

/** JVM stdlib / well-known package prefixes (shared by the java and kotlin metas). */
const JVM_EXTERNAL_PREFIXES = [
  "java.", "javax.", "jakarta.",
  "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.",
  "io.ktor.", "io.netty.",
  "com.google.", "com.fasterxml.", "com.amazonaws.",
];

/** Reverse-domain namespace roots that mark imports as external for directory resolution. */
const JVM_NAMESPACE_ROOTS = ["java", "javax", "jakarta", "org", "com", "io"];

const JVM_FRAMEWORK_HINTS: Readonly<Record<string, string>> = {
  "io.ktor.server.routing": "ktor",
  "org.springframework.web.bind.annotation": "spring-web",
  "org.hibernate": "hibernate",
  "javax.persistence": "hibernate",
  "jakarta.persistence": "hibernate",
  "org.eclipse.persistence": "eclipselink",
  "org.apache.openjpa": "openjpa",
  "org.springframework.data.jpa": "spring-data-jpa",
  "org.springframework.data.jdbc": "spring-data-jdbc",
  "org.springframework.data.relational": "spring-data-jdbc",
  "org.mybatis": "mybatis",
  "org.jooq": "jooq",
  "org.jetbrains.exposed": "exposed",
};

const JVM_DB_ROOTS = ["JdbcTemplate", "entityManager", "session", "repository"];

function jvmMeta(language: Language, opts: {
  extensions: string[];
  builtinTypes: ReadonlySet<string>;
  branchNodes: string[];
  apiCallRoots: string[];
  calls: CallExtractionHooks;
  grammar: LanguagePluginMeta["grammar"];
  testFilePatterns: readonly RegExp[];
}): LanguagePluginMeta {
  return {
    language,
    parsing: "tree-sitter",
    extensions: opts.extensions,
    testFilePatterns: opts.testFilePatterns,
    grammar: opts.grammar,
    builtinTypes: opts.builtinTypes,
    externalModulePrefixes: JVM_EXTERNAL_PREFIXES,
    externalNamespaceRoots: JVM_NAMESPACE_ROOTS,
    complexity: {
      branchNodes: new Set(opts.branchNodes),
      logicalOps: new Set(["&&", "||"]),
    },
    frameworkImportHints: JVM_FRAMEWORK_HINTS,
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
  extensions: [".java"],
  builtinTypes: JAVA_BUILTINS,
  branchNodes: [
    "if_statement", "while_statement", "for_statement", "enhanced_for_statement",
    "catch_clause", "ternary_expression", "switch_block_statement_group",
  ],
  apiCallRoots: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit"],
  calls: javaCallHooks,
  grammar: { variants: { java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" } } },
  // JUnit/TestNG: `FooTest.java`, `FooTests.java`, and `FooIT`/`FooITCase` integration tests.
  testFilePatterns: [/(Test|Tests|IT|ITCase)\.java$/],
});

export const kotlinMeta: LanguagePluginMeta = jvmMeta("kotlin", {
  extensions: [".kt", ".kts"],
  builtinTypes: KOTLIN_BUILTINS,
  branchNodes: [
    "if_expression", "while_statement", "for_statement",
    "catch_block", "when_entry",
  ],
  apiCallRoots: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit", "ktor"],
  calls: kotlinCallHooks,
  grammar: { variants: { kotlin: { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" } } },
  // JUnit/Kotest: `FooTest.kt`, `FooTests.kt`, and `FooIT`/`FooITCase` integration tests.
  testFilePatterns: [/(Test|Tests|IT|ITCase)\.kt$/],
});
