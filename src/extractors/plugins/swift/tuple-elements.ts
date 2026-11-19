/**
 * The element types of a Swift tuple type a function declares it returns, in order, for a tuple pattern
 * (`let (club, player) = load()`): `(Club, Player)` and the labelled `(club: Club, player: Player)` (labels
 * dropped). Null for any other type: an optional tuple, one element (`(Club)` is just `Club`), a class.
 */
export function swiftTupleElements(returnType: string): string[] | null {
  const text = returnType.trim();
  if (!text.startsWith("(") || !text.endsWith(")")) return null;
  const parts: string[] = [];
  let depth = 0;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (ch === "(" || ch === "<" || ch === "[") depth++;
    else if (ch === ")" || ch === ">" || ch === "]") {
      depth--;
      // The opening parenthesis closed before the end: `(A, B) -> C`, a function type.
      if (depth === 0 && i < text.length - 1) return null;
    } else if (ch === "," && depth === 1) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start, text.length - 1));
  const elements = parts.map((p) => p.trim().replace(/^[A-Za-z_]\w*\s*:\s*/, ""));
  return elements.length >= 2 && elements.every((e) => e !== "") ? elements : null;
}
