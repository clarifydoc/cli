/**
 * The element a declared collection type states, as a leaf the language manifests share (the symbol linker types a
 * loop variable from the declared type of a field or a call's result through it): `Club[]`, `Array<Club>`,
 * `list[Club]`, `List<Club>`, `IEnumerable<Club>`, `[]*Club`, `List<Club>?`. Null for a map (a loop yields keys or
 * entries, never the value alone), a union, a tuple of several types and any element that is not a plain type name.
 * Whether the element is a project class is the linker's call.
 */

const SEQUENCES = new Set([
  "Array", "ReadonlyArray", "Set", "ReadonlySet", "Iterable", "IterableIterator", "Iterator", "Collection", "Queue", "Stack",
  "list", "List", "set", "frozenset", "FrozenSet", "Sequence", "MutableSequence", "AbstractSet", "MutableSet", "Deque", "deque",
  "Generator", "tuple", "Tuple",
  "ArrayList", "LinkedList", "Vector", "HashSet", "TreeSet", "LinkedHashSet", "SortedSet", "NavigableSet", "Stream", "ArrayDeque",
  "IList", "ICollection", "IEnumerable", "IReadOnlyList", "IReadOnlyCollection", "IAsyncEnumerable", "ISet", "HashSet", "ImmutableList",
  "ImmutableArray", "ReadOnlyCollection", "ObservableCollection", "Collection", "MutableList", "MutableCollection", "MutableSet", "Iterable",
  "ReadOnlyList", "Seq", "Sequence",
]);

/** The top-level arguments of `A, B<C, D>` → `["A", "B<C, D>"]`. */
function topLevelArgs(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (ch === "<" || ch === "[" || ch === "(") depth++;
    else if (ch === ">" || ch === "]" || ch === ")") depth--;
    else if ((ch === "," && depth === 0) || i === body.length) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  return out;
}

export function collectionElementText(type: string | null | undefined): string | null {
  let t = (type ?? "").trim().replace(/\b(?:typing|collections(?:\.abc)?)\./g, "").replace(/^readonly\s+/, "");
  // `Club | None`, `Club | undefined`, a nullable `List<Club>?`.
  t = t.split("|").map((p) => p.trim()).filter((p) => p && !/^(?:None|null|undefined)$/.test(p)).join("|");
  t = t.replace(/\?$/, "");
  const opt = /^Optional\[(.+)\]$/.exec(t);
  if (opt) t = opt[1]!.trim();
  if (!t || t.includes("|")) return null;
  let element: string | null = null;
  const slice = /^\[\d*\]\s*(.+)$/.exec(t);
  if (slice) element = slice[1]!;
  else if (t.endsWith("[]") && !t.includes("<") && !t.includes("(")) element = t.slice(0, -2);
  else if (t.endsWith("[]")) element = t.slice(0, -2).replace(/^\((.*)\)$/, "$1");
  else {
    const m = /^([A-Za-z_][\w.]*)\s*[<[]([\s\S]+)[>\]]$/.exec(t);
    if (!m) return null;
    const name = m[1]!.split(".").pop()!;
    if (!SEQUENCES.has(name)) return null;
    const args = topLevelArgs(m[2]!);
    if (/^(?:tuple|Tuple)$/.test(name)) element = args.length === 2 && args[1] === "..." ? args[0]! : args.length === 1 ? args[0]! : null;
    else element = args.length === 1 ? args[0]! : null;
  }
  element = element?.trim().replace(/^readonly\s+/, "").replace(/^(['"])(.*)\1$/, "$2").replace(/^\*+|\?$/g, "") ?? null;
  // Another collection, a function or an inline type is no class: `string[][]`, `() => X`.
  if (!element || /[|&(){}\s]/.test(element) || element.endsWith("]")) return null;
  return element;
}
