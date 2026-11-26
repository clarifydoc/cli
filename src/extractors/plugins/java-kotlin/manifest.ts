import { valueOut } from "../../shared/value-out.js";
import { jvmElementText, jvmIndexedElement, kotlinIndexedElement, kotlinTupleElements } from "./wrapper-elements.js";
import { jvmMigrationFiles } from "./migration-files.js";
import { jvmProjectCommands } from "./project-commands.js";
import { jvmTestCommand } from "./test-command.js";
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";
import { javaKotlinFrameworkRules } from "./frameworks.js";
import { mavenPackageManager, gradlePackageManager } from "./package-manifests.js";
import { jvmServiceConfig } from "./service-config.js";
import { jvmPlatformFunctionTypes } from "./function-types.js";
import { C_STYLE_DOCS } from "../../shared/doc-comment-specs.js";

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
 * to collide (`ClubApiImpl.toList`) would magnet every such call site in
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

/**
 * Calls that take the value out of a JVM wrapper, and the wrappers each one unwraps (the `valueOut` hook's `calls`).
 *
 * Only a wrapper the hook unwraps is listed. One whose members are its own (Java `Optional`/`Provider`, Kotlin `Lazy`)
 * is never a `transparentTypeWrappers` entry: `opt.get()` would link to a `get` of the wrapped class. Core's
 * `walkChain` asks the hook (`takes` before reading any declaration, `at` on the declared type) and goes on from the
 * wrapper's first type argument when the call before one of these DECLARES a listed wrapper: `var c =
 * repo.findAsync(id).join(); c.promote()` and `repo.findMono(id).block().relegate()` reach `Club`. A project class's
 * own `get()` keeps its declared return type, an unlisted generic's `join()` unwraps nothing, and keys are read as
 * own properties only (`toString` is no unwrapping call).
 *
 * A wrapper a field, parameter or method DECLARES (`private Provider<ClubRepo> provider; provider.get().save()`) is
 * read by `unwrappedDeclared`/`wrappedHead` from the written type; the `members` table names Kotlin `.value` on a
 * `Lazy<T>`. `wrapperShadowed`: the hook returns the head it read and core refuses a project class of that name, so
 * `Box<ClubRepo>.value` or a project class with its own `get()`/`Value` unwraps nothing.
 *
 * A local holding the unwrapped value (`var c = repo.find(1); c.get().save()`) reads the wrapper off the declared
 * return of the one call the local is initialized from (not awaited, no `choice`). A Kotlin `val s = lazy.value` and
 * every plain member read (Java `var m = club.manager`, Kotlin `val t = settings.turf`; never a call, indexer or `?.`
 * in the path) state `localTypes[].from` with `member: true`: the plugin never consults `members`, the linker takes the
 * value out of a listed wrapper and else types the local by the member's declared type, untyped where that is no
 * project class.
 *
 * Elements: `elementCalls` (`get`) with `elementOf` (`jvmIndexedElement`: a `List`'s element, a `Map`'s VALUE, one
 * plain type name) take one element out of what the segment before DECLARES — `repo.all().get(0).promote()`,
 * `club.players.get(0)`, Kotlin `var c = repo.all()[1]` (stated as written, an `index` segment of the receiver chain,
 * kept only where the hook has an `index` member — Kotlin `get`). A project class's own `get(int)` keeps its declared
 * return and a project class named like the collection shadows it. `arrayIndex` (Java) reads `x[i]` over a declared
 * array (`Position.values()[0].label()`) and yields nothing for any other type; Kotlin `Array<X>` is indexed,
 * `first`/`last` take an element. In `valueOut.calls` the keys are `join`, `get`, `orElseThrow`, `block` and Kotlin `await`
 * (`Deferred`); `valueOut.arrayIndex` is the Java array step.
 *
 * Map entries: a loop over `m.entrySet()` / Kotlin `m.entries` / a map looped directly is a `kind: "entry"` state of the
 * shared element chain (`ChainRules.entries`/`entryValue`/`entryKey`: `entrySet()` is a collection whose `elemState`
 * carries the key and value types, never a `Map.Entry<K, V>` text), so `en.getValue()`, `en.getKey()` and Kotlin
 * `en.value` type; a name two loops bind to different entries is dropped. Only a TYPED map root (parameter, field,
 * typed local) is read; a call-initialized map (`repo.byName().entrySet()`) stays untyped.
 */
const JVM_UNWRAP_CALLS: Readonly<Record<string, readonly string[]>> = {
  join: ["CompletableFuture"],
  get: ["CompletableFuture", "Future", "Optional", "Provider", "Supplier"],
  orElseThrow: ["Optional"],
  block: ["Mono"],
};

export const javaManifest: LanguagePluginManifest = {
  docComments: C_STYLE_DOCS,
  migrationFiles: jvmMigrationFiles,
  testCommand: jvmTestCommand,
  projectCommands: jvmProjectCommands,
  language: "java",
  ownerPathTypes: true,
  callPathsFromHead: true,
  // No `await`: the value comes out of a future, a `Mono` or an `Optional` through these calls.
  valueOut: valueOut({ calls: JVM_UNWRAP_CALLS, elementCalls: ["get"], elementOf: jvmIndexedElement, arrayIndex: true }),
  collectionElementOf: jvmElementText("java"),
  family: "jvm",
  packageManagers: [mavenPackageManager, gradlePackageManager],
  packageEcosystems: ["maven"],
  importsDeclaredPackages: true,
  // Spring relaxed binding: `person.service.url` ← `PERSON_SERVICE_URL`.
  serviceConfig: jvmServiceConfig,
  parsing: "tree-sitter",
  extensions: [".java"],
  // Maven/Gradle source sets: below `src/<set>/java/` every directory is a package.
  packageRoots: [/(?:^|\/)src\/[^/]+\/java\//],
  grammar: { variants: { java: { pkg: "tree-sitter-java", wasm: "tree-sitter-java.wasm" } } },
  // The name suffix outside Maven/Gradle's `src/main/java/`, which holds production
  // code only (a `@RestController` named `AuthCheckTest` there is served).
  testFilePatterns: [/^(?!(?:.*[\\/])?src[\\/]main[\\/]java[\\/]).*(Test|Tests|IT|ITCase)\.java$/],
  testSubjectAffixes: { suffixes: ["ITCase", "Tests", "Test", "IT"] },
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  platformFunctionTypes: jvmPlatformFunctionTypes,
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
  frameworkRules: javaKotlinFrameworkRules,
  activationFiles: ["pom.xml", "build.gradle", "build.gradle.kts"],
  builtinMembers: JVM_BUILTIN_MEMBERS,
  // Kotlin's `object` (`INSTANCE`) and companion (`Companion`) as Java sees them.
  classMemberHolders: ["INSTANCE", "Companion"],
  // Files that mark a sub-project root (core's project detector); a lower `priority` wins a directory holding several kinds.
  projectMarkers: [
    { pattern: "**/pom.xml", kind: "java-maven", priority: 70 },
    { pattern: "**/build.gradle", kind: "java-gradle", priority: 80 },
    { pattern: "**/build.gradle.kts", kind: "java-gradle", priority: 80 },
  ],
};

export const kotlinManifest: LanguagePluginManifest = {
  docComments: C_STYLE_DOCS,
  testCommand: jvmTestCommand,
  // `runBlocking` and `Thread.sleep` inside a `suspend` function park the coroutine's thread.
  blockingCalls: /^(?:runBlocking|Thread\.sleep)$/,
  language: "kotlin",
  ownerPathTypes: true,
  callPathsFromHead: true,
  // `lazy.value` of a declared `Lazy<ClubRepo>`.
  valueOut: valueOut({ calls: { ...JVM_UNWRAP_CALLS, await: ["Deferred"] }, members: { value: ["Lazy"] }, elementCalls: ["get", "first", "last"], elementOf: kotlinIndexedElement, index: "get" }),
  collectionElementOf: jvmElementText("kotlin"),
  // `val (club, player) = load()` over a declared `Pair<Club, Player>` / `Triple`; over a data class, its constructor's
  // properties in order (`componentN`).
  tupleElementsOf: kotlinTupleElements,
  bindsStructFields: true,
  family: "jvm",
  // A package's top-level functions need no import in its other files.
  directoryScope: true,
  // ...by `package`, not by folder: `src/a/Club.kt` and `src/b/Use.kt` of one package see each other.
  packageScope: true,
  bareMembersHideFunctions: true,
  importsDeclaredPackages: true,
  packageEcosystems: ["maven"],
  // Spring relaxed binding: `person.service.url` ← `PERSON_SERVICE_URL`.
  serviceConfig: jvmServiceConfig,
  parsing: "tree-sitter",
  extensions: [".kt", ".kts"],
  // Gradle source sets (`src/main/kotlin/`, multiplatform `src/commonMain/kotlin/`).
  packageRoots: [/(?:^|\/)src\/[^/]+\/kotlin\//],
  grammar: { variants: { kotlin: { pkg: "tree-sitter-kotlin", wasm: "tree-sitter-kotlin.wasm" } } },
  testFilePatterns: [/^(?!(?:.*[\\/])?src[\\/]main[\\/](?:kotlin|java)[\\/]).*(Test|Tests|IT|ITCase)\.kt$/],
  testSubjectAffixes: { suffixes: ["ITCase", "Tests", "Test", "IT"] },
  externalModulePrefixes: ["java.", "javax.", "jakarta.", "org.springframework.", "org.apache.", "org.hibernate.", "org.junit.", "io.ktor.", "io.netty.", "com.google.", "com.fasterxml.", "com.amazonaws."],
  externalNamespaceRoots: ["java", "javax", "jakarta", "org", "com", "io"],
  platformFunctionTypes: jvmPlatformFunctionTypes,
  frameworkImportHints: { "io.ktor.server.routing": "ktor", "org.springframework.web.bind.annotation": "spring-web", "org.hibernate": "hibernate", "javax.persistence": "hibernate", "jakarta.persistence": "hibernate", "org.eclipse.persistence": "eclipselink", "org.apache.openjpa": "openjpa", "org.springframework.data.jpa": "spring-data-jpa", "org.springframework.data.jdbc": "spring-data-jdbc", "org.springframework.data.relational": "spring-data-jdbc", "org.mybatis": "mybatis", "org.jooq": "jooq", "org.jetbrains.exposed": "exposed" },
  builtinMembers: JVM_BUILTIN_MEMBERS,
};
