/**
 * The platform's function types as data (leaf module: the static manifest and the value-flow reader both import it).
 * Core answers "is this bare name the platform's function type in this file?" from this list and the file's own
 * imports, package and declared classes.
 */
import type { LanguagePluginManifest } from "../../../types/language-plugin.js";

/** Functional interfaces of the JDK (and the common Kotlin aliases) whose single method runs a function. */
export const FN_INTERFACES: ReadonlySet<string> = new Set([
  "Runnable", "Callable", "Supplier", "Consumer", "BiConsumer", "Function", "BiFunction", "UnaryOperator", "BinaryOperator",
  "Predicate", "BiPredicate", "Comparator", "IntFunction", "IntSupplier", "IntConsumer", "IntPredicate", "IntUnaryOperator",
  "IntBinaryOperator", "ToIntFunction", "ToLongFunction", "ToDoubleFunction", "LongSupplier", "LongFunction", "LongConsumer",
  "DoubleSupplier", "DoubleFunction", "DoubleConsumer", "BooleanSupplier", "ObjIntConsumer",
]);

/** Functional interfaces a file names without an import: `java.lang`'s (and Kotlin's `Comparator` alias). */
export const FN_DEFAULT_IMPORTED: ReadonlySet<string> = new Set(["Runnable", "Comparator"]);

export const jvmPlatformFunctionTypes: NonNullable<LanguagePluginManifest["platformFunctionTypes"]> = {
  names: [...FN_INTERFACES],
  implicit: [...FN_DEFAULT_IMPORTED],
};
