import { genericParts } from "../shared/element-chain.js";
import { collectionElementText } from "../../shared/collection-element.js";

/**
 * Single-value and stream wrappers whose one type argument is the element an operator lambda receives
 * (`repo.findById(id).flatMap(club -> club.promote())`). Collections are the shared reader's.
 */
const JAVA_WRAPPERS: ReadonlySet<string> = new Set(["Mono", "Flux", "CompletableFuture", "CompletionStage", "Optional", "Stream"]);
const KOTLIN_WRAPPERS: ReadonlySet<string> = new Set([...JAVA_WRAPPERS, "Deferred", "Flow"]);

/** The element of a declared wrapper or collection type; null for any other generic (a project `Box<Club>`). */
export function jvmElementText(language: "java" | "kotlin"): (type: string | null | undefined) => string | null {
  const wrappers = language === "java" ? JAVA_WRAPPERS : KOTLIN_WRAPPERS;
  return (type) => {
    const shared = collectionElementText(type);
    if (shared) return shared;
    const m = /^\s*(?:[A-Za-z_][\w]*\.)*([A-Za-z_]\w*)\s*<([\s\S]+)>\s*\??\s*$/.exec(type ?? "");
    if (!m || !wrappers.has(m[1]!)) return null;
    // Only a plain type name is an element: `Mono<List<Club>>` stays a collection-in-a-wrapper (its element is a collection, not a class a member call lands on).
    const arg = m[2]!.trim().replace(/^(?:\?\s*(?:extends|super)\s+|out\s+)/, "");
    return /^[A-Za-z_][\w.]*$/.test(arg) ? arg : null;
  };
}

/**
 * The element types of a Kotlin `Pair<Club, Player>` / `Triple<A, B, C>` a function declares it returns, in order, for
 * a destructuring declaration (`val (club, player) = load()`); null for any other type, a project class named
 * `Pair` included only by its arity (two or three arguments, each a named type — never a star projection).
 */
export function kotlinTupleElements(returnType: string): string[] | null {
  const parts = genericParts(returnType);
  if (!parts || parts.args.some((a) => !/^[A-Za-z_][\w.]*(?:<[\s\S]*>)?\??$/.test(a))) return null;
  if (parts.name === "Pair" && parts.args.length === 2) return parts.args;
  if (parts.name === "Triple" && parts.args.length === 3) return parts.args;
  return null;
}

const LISTS: ReadonlySet<string> = new Set(["List", "ArrayList", "LinkedList", "Vector", "CopyOnWriteArrayList", "MutableList", "Deque", "ArrayDeque", "Array"]);
const MAP_TYPES: ReadonlySet<string> = new Set(["Map", "HashMap", "TreeMap", "LinkedHashMap", "SortedMap", "NavigableMap", "ConcurrentMap", "ConcurrentHashMap", "MutableMap"]);

/**
 * What `x.get(i)` / `x[i]` yields on a declared list or map: the list's element, the map's value (never its key); null
 * for any other type — an `Optional`, a `Set` (no index) or a project class named like none of them — and for an
 * element that is not one plain type name.
 */
export function jvmIndexedElement(type: string): string | null {
  const parts = genericParts(type);
  if (!parts) return null;
  const arg = LISTS.has(parts.name) && parts.args.length === 1 ? parts.args[0] : MAP_TYPES.has(parts.name) && parts.args.length === 2 ? parts.args[1] : undefined;
  return arg && /^[A-Za-z_][\w.]*$/.test(arg) ? arg : null;
}

/** Kotlin: `get`/`[i]` take a list's element or a map's value; `first()`/`last()` only a list's (a map's is an entry). */
export function kotlinIndexedElement(type: string, hop: { name: string }): string | null {
  if (hop.name !== "first" && hop.name !== "last") return jvmIndexedElement(type);
  const parts = genericParts(type);
  return parts && LISTS.has(parts.name) ? jvmIndexedElement(type) : null;
}
