/** `[Club]`, `Array<Club>`, `Set<League.Club>`, `[Club]?`: the element type of a plain typed collection. Leaf: the manifest uses it. */
export function elementType(type: string | null | undefined): string | null {
  const m = /^\s*(?:\[\s*([A-Z][\w.]*)\s*\]|(?:Array|Set|ContiguousArray|ArraySlice)\s*<\s*([A-Z][\w.]*)\s*>)\s*[?!]?\s*$/.exec(type ?? "");
  return m?.[1] ?? m?.[2] ?? null;
}
