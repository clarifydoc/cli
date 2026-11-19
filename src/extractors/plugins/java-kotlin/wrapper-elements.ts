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
 * `Pair` included only by its arity (two or three arguments, none a star projection).
 */
export function kotlinTupleElements(returnType: string): string[] | null {
  const parts = genericParts(returnType);
  if (!parts) return null;
  if (parts.name === "Pair" && parts.args.length === 2) return parts.args;
  if (parts.name === "Triple" && parts.args.length === 3) return parts.args;
  return null;
}
