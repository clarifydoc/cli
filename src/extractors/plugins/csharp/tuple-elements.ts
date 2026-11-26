import { genericParts, splitTypeArgs } from "../shared/element-chain.js";
import { matchingParen } from "../shared/text-scan.js";

/**
 * The element types of a declared C# tuple a method returns, in order, for a deconstruction
 * (`var (club, player) = Load();`): `(Club, Player)`, a named one `(Club club, Player player)` (the names are
 * dropped), `ValueTuple<Club, Player>` / `Tuple<Club, Player>`. Null for any other type: a nullable tuple, one
 * element, a class (it may declare its own `Deconstruct`, which this does not read).
 *
 * Both `var (club, player) = Load()` and `(var club, var player) = Load()` (also awaited through `Task`) give
 * `fromIndex` locals, typed through the manifest's `tupleElementsOf` (a `ValueTuple<…>` return counts too); a
 * discard or nested pattern only takes up a position.
 */
export function csharpTupleElements(returnType: string): string[] | null {
  const text = returnType.trim();
  let parts: string[];
  if (text.startsWith("(") && text.endsWith(")")) {
    // The opening parenthesis must close at the end (`(A, B)`, not `(A, B).Foo(C)`).
    if (matchingParen(text, 0) !== text.length - 1) return null;
    parts = splitTypeArgs(text.slice(1, -1)).map(stripElementName);
  } else {
    const generic = genericParts(text);
    if (!generic || (generic.name !== "ValueTuple" && generic.name !== "Tuple")) return null;
    parts = generic.args;
  }
  return parts.length >= 2 && parts.every((p) => p !== "") ? parts : null;
}

/** `Club club` → `Club`, `Dictionary<string, Club> byName` → `Dictionary<string, Club>`; a lone type stays. */
function stripElementName(element: string): string {
  const m = /^([\s\S]*[^\s])\s+[A-Za-z_]\w*$/.exec(element.trim());
  return m && !/[,<(\[]\s*$/.test(m[1]!) && !/\b(?:ref|in|out|params)$/.test(m[1]!) ? m[1]! : element.trim();
}
