import { jvmMigrationFiles } from "./migration-files.js";
import { jvmProjectCommands } from "./project-commands.js";
import { jvmTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { javaKotlinFrameworkRules } from "./frameworks.js";
import { mavenPackageManager, gradlePackageManager } from "./package-manifests.js";
import { jvmServiceConfig } from "./service-config.js";

/**
 * Static tier of this plugin — the cheap pure data the registry aggregates
 * EAGERLY (extensions, grammar location, framework rules, …). The heavy
 * body (meta.ts and everything it imports) is loaded lazily per language;
 * this module must stay a leaf: types, frameworks.ts, package-manifests.ts and service-config.ts only.
 */
/**
 * JDK / Kotlin-stdlib member names that must never be resolved by name-only
 * heuristics: a call like `x.stream().toList()` or `ex.getMessage()` is
 * overwhelmingly a platform call, so a uniquely-named app method that happens
 * to collide (`CustomerApiImpl.toList`) would magnet every such call site in
 * the repo. Fed into ALL_BUILTIN_MEMBERS (symbol-linker Strategy 7 veto).
 * Builder members cover Lombok/protobuf/immutables generated code.
 */
const JVM_BUILTIN_MEMBERS = [
  // Collections / Map / Iterable / Deque
  "isEmpty", "size", "contains", "containsAll", "containsKey", "containsValue",
  "add", "addAll", "remove", "removeIf", "removeAll", "retainAll", "clear",
  "get", "getOrDefault", "getOrElse", "put", "putAll", "putIfAbsent",
  "computeIfAbsent", "computeIfPresent", "merge", "keySet", "entrySet", "values",
  "indexOf", "lastIndexOf", "subList", "toArray", "iterator", "listIterator",
  "forEach", "getFirst", "getLast", "addFirst", "addLast", "removeFirst",
  "removeLast", "push", "pop", "peek", "poll", "offer", "element",
  // Streams / collectors / comparators
  "stream", "parallelStream", "filter", "map", "mapToInt", "mapToLong",
  "mapToObj", "mapToDouble", "flatMap", "distinct", "sorted", "limit", "skip",
  "collect", "toList", "toSet", "reduce", "findFirst", "findAny", "anyMatch",
  "allMatch", "noneMatch", "count", "min", "max", "sum", "average", "boxed",
  "of", "copyOf", "ofNullable", "generate", "iterate", "concat", "empty",
  "range", "rangeClosed", "groupingBy", "joining", "mapping", "partitioningBy",
  "toMap", "toUnmodifiableList", "comparing", "thenComparing", "reversed",
  "naturalOrder",
  // String / boxing / formatting
  "charAt", "length", "isBlank", "trim", "strip", "stripLeading",
  "stripTrailing", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
  "substring", "replace", "replaceAll", "replaceFirst", "split", "join",
  "format", "formatted", "matches", "repeat", "lines", "chars", "codePoints",
  "intern", "toCharArray", "getBytes", "contentEquals", "equalsIgnoreCase",
  "compareToIgnoreCase", "valueOf", "parseInt", "parseLong", "parseDouble",
  "parseFloat", "parseBoolean", "intValue", "longValue", "doubleValue",
  "floatValue", "booleanValue", "shortValue", "byteValue", "append",
  // Object / Class / enum / Throwable
  "toString", "equals", "hashCode", "getClass", "getName", "getSimpleName",
  "getCanonicalName", "name", "ordinal", "compareTo", "compare", "clone",
  "getMessage", "getLocalizedMessage", "getCause", "getStackTrace",
  "printStackTrace", "addSuppressed", "getSuppressed", "initCause",
  // Optional / CompletableFuture / concurrency
  "isPresent", "orElse", "orElseGet", "orElseThrow", "ifPresent",
  "ifPresentOrElse", "thenApply", "thenAccept", "thenRun", "thenCompose",
  "thenCombine", "exceptionally", "whenComplete", "handle", "complete",
  "completedFuture", "supplyAsync", "runAsync", "cancel", "isDone",
  "isCancelled", "await", "countDown", "lock", "unlock", "tryLock", "submit",
  "execute", "shutdown", "shutdownNow", "schedule", "scheduleAtFixedRate",
  // java.time
  "now", "parse", "plus", "minus", "plusDays", "plusHours", "plusMinutes",
  "plusSeconds", "plusWeeks", "plusMonths", "plusYears", "minusDays",
  "minusHours", "minusMinutes", "minusSeconds", "minusWeeks", "minusMonths",
  "minusYears", "atZone", "atStartOfDay", "toInstant", "toEpochMilli",
  "toLocalDate", "toLocalDateTime", "toLocalTime", "isBefore", "isAfter",
  "isEqual", "getTime", "getYear", "getMonth", "getMonthValue",
  "getDayOfMonth", "getDayOfWeek", "getHour", "getMinute", "getSecond",
  "between", "until", "ofPattern", "truncatedTo",
  // Generated-code builders (Lombok / protobuf / immutables)
  "build", "builder", "toBuilder", "newBuilder", "newInstance",
  // Kotlin stdlib scope functions / collection extensions / data-class members
  "let", "also", "apply", "run", "takeIf", "takeUnless", "first",
  "firstOrNull", "last", "lastOrNull", "single", "singleOrNull", "mapNotNull",
  "filterNotNull", "filterIsInstance", "joinToString", "isNullOrEmpty",
  "isNullOrBlank", "orEmpty", "toMutableList", "toMutableMap", "toMutableSet",
  "toIntOrNull", "toLongOrNull", "toDoubleOrNull", "associate", "associateBy",
  "associateWith", "groupBy", "sortedBy", "sortedByDescending", "sortedWith",
  "maxByOrNull", "minByOrNull", "maxOfOrNull", "minOfOrNull", "sumOf", "fold",
  "foldRight", "reduceOrNull", "forEachIndexed", "mapIndexed", "filterIndexed",
  "withIndex", "ifEmpty", "ifBlank", "coerceIn", "coerceAtLeast",
  "coerceAtMost", "downTo", "step", "zip", "unzip", "partition", "chunked",
  "windowed", "flatten", "distinctBy", "none", "any", "all", "getValue",
  "setValue", "component1", "component2", "copy",
];

export const javaManifest: LanguagePluginManifest = {
  migrationFiles: jvmMigrationFiles,
  testCommand: jvmTestCommand,
  projectCommands: jvmProjectCommands,
  language: "java",
  family: "jvm",
  packageManagers: [mavenPackageManager, gradlePackageManager],
  packageEcosystems: ["maven"],
  // Spring relaxed binding: `person.service.url` ← `PERSON_SERVICE_URL`.
  serviceConfig: jvmServiceConfig,
  parsing: "tree-sitter",
  extensions: [".java"],
  grammar: { variants: { java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" } } },
  // The name suffix outside Maven/Gradle's `src/main/java/`, which holds production
  // code only (a `@RestController` named `AuthCheckTest` there is served).
  testFilePatterns: [/^(?!(?:.*[\\/])?src[\\/]main[\\/]java[\\/]).*(Test|Tests|IT|ITCase)\.java$/],
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
  frameworkRules: javaKotlinFrameworkRules,
  activationFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
  builtinMembers: JVM_BUILTIN_MEMBERS,
};

export const kotlinManifest: LanguagePluginManifest = {
  testCommand: jvmTestCommand,
  language: "kotlin",
  family: "jvm",
  // A package's top-level functions need no import in its other files.
  directoryScope: true,
  packageEcosystems: ["maven"],
  // Spring relaxed binding: `person.service.url` ← `PERSON_SERVICE_URL`.
  serviceConfig: jvmServiceConfig,
  parsing: "tree-sitter",
  extensions: [".kt", ".kts"],
  grammar: { variants: { kotlin: { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" } } },
  testFilePatterns: [/^(?!(?:.*[\\/])?src[\\/]main[\\/](?:kotlin|java)[\\/]).*(Test|Tests|IT|ITCase)\.kt$/],
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
  builtinMembers: JVM_BUILTIN_MEMBERS,
};
