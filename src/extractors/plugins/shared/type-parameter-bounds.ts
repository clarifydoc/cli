/**
 * The bound a type written as a bare type-parameter letter stands for, else the type unchanged.
 * `bounds` maps each letter in scope to its (first) bound, or `null` for an unbounded letter.
 */
export function boundedType(type: string | null | undefined, bounds: ReadonlyMap<string, string | null>): string | null | undefined {
  if (!type || bounds.size === 0) return type;
  const key = type.trim().replace(/\?$/, "");
  return bounds.has(key) ? (bounds.get(key) ?? type) : type;
}

/** A bound that is itself another type parameter of the member names no class: the letter stays untyped. */
export function dropLetterBounds(bounds: Map<string, string | null>): void {
  for (const [name, bound] of bounds) if (bound !== null && bounds.has(bound.replace(/\?$/, ""))) bounds.set(name, null);
}
