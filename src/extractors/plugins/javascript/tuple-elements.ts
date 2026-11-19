/**
 * The element types of a declared tuple type as TypeScript writes it (`[Club, Player]` → `["Club", "Player"]`;
 * `readonly [Club, Player]`, labelled members `[club: Club, player: Player]`), or null for any other type: an array
 * (`Club[]`, `[Club, Player][]`), a rest or optional member, an empty tuple. Read for a local bound by array
 * destructuring of a call (`const [club, player] = load()`).
 */
export function tupleElementsText(type: string): string[] | null {
  const text = type.trim().replace(/^readonly\s+/, "");
  if (!text.startsWith("[") || !text.endsWith("]")) return null;
  const out: string[] = [];
  let depth = 0;
  let start = 1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ">" && text[i - 1] === "=") continue;
    if (ch === "[" || ch === "(" || ch === "<" || ch === "{") depth++;
    else if (ch === "]" || ch === ")" || ch === ">" || ch === "}") {
      depth--;
      // The opening bracket closed before the end: `[A, B][]`, an array of tuples.
      if (depth === 0 && i < text.length - 1) return null;
    } else if (depth === 1 && ch === ",") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start, text.length - 1));
  const elements = out.map((e) => e.trim().replace(/^[A-Za-z_$][\w$]*(\??)\s*:\s*/, (_m, optional: string) => (optional ? "?" : ""))).filter((e) => e.length > 0);
  if (elements.length !== out.length || elements.length === 0) return null;
  return elements.some((e) => e.startsWith("...") || /\?$/.test(e) || e.startsWith("?")) ? null : elements;
}
