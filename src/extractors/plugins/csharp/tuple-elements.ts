import { genericParts, splitTypeArgs } from "../shared/element-chain.js";

/**
 * The element types of a declared C# tuple a method returns, in order, for a deconstruction
 * (`var (club, player) = Load();`): `(Club, Player)`, a named one `(Club club, Player player)` (the names are
 * dropped), `ValueTuple<Club, Player>` / `Tuple<Club, Player>`. Null for any other type: a nullable tuple, one
 * element, a class (it may declare its own `Deconstruct`, which this does not read).
 */
export function csharpTupleElements(returnType: string): string[] | null {
  const text = returnType.trim();
  let parts: string[];
  if (text.startsWith("(") && text.endsWith(")")) {
    // The opening parenthesis must close at the end (`(A, B)`, not `(A, B).Foo(C)`).
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(" || ch === "<" || ch === "[") depth++;
      else if (ch === ")" || ch === ">" || ch === "]") {
        depth--;
        if (depth === 0 && i < text.length - 1) return null;
      }
    }
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
