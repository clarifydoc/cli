import { namesReceiverType } from "./di.js";

/**
 * The element a TypeScript collection type states, for the variable a loop or a callback binds from it:
 * `Club[]`, `Array<Club>`, `ReadonlyArray<Club>`, `Set<Club>`, `Iterable<Club>` → `Club`; `Map<string, Club>` →
 * `Club` with `map: true` (a `for … of` over a map yields `[key, value]` pairs, `.values()` the values).
 * Null for anything else, and for an element that names no class a member call can land on (`string[]`).
 */
export function collectionElement(type: string | null | undefined): { element: string; map: boolean } | null {
  let t = (type ?? "").trim();
  t = t.split("|").map((m) => m.trim()).filter((m) => m && m !== "null" && m !== "undefined").join("|");
  if (!t || t.includes("|")) return null;
  t = t.replace(/^readonly\s+/, "");
  const wrap = /^\(\s*([^()]+?)\s*\)\[\]$/.exec(t);
  if (wrap) t = `${wrap[1]}[]`;
  let element: string | null = null;
  let map = false;
  if (t.endsWith("[]")) element = t.slice(0, -2);
  else {
    const m = /^(?:Array|ReadonlyArray|Set|ReadonlySet|Iterable|IterableIterator|Iterator|Collection|Queue|Stack)\s*<\s*(.+)\s*>$/.exec(t);
    if (m) element = m[1]!;
    else {
      const kv = /^(?:Map|ReadonlyMap|WeakMap)\s*<\s*(.+)\s*>$/.exec(t);
      if (kv) {
        const args = splitTopLevel(kv[1]!);
        if (args.length === 2) {
          element = args[1]!;
          map = true;
        }
      }
    }
  }
  element = element?.trim().replace(/^readonly\s+/, "") ?? null;
  return element && namesReceiverType(element) ? { element, map } : null;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ">" || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(text.slice(start).trim());
  return out;
}

/** Array methods whose callback's first parameter is the element (a `Set`/`Map` has `forEach` only). */
export const ELEMENT_CALLBACKS: ReadonlySet<string> = new Set([
  "forEach", "map", "filter", "find", "findLast", "findIndex", "findLastIndex", "some", "every", "flatMap", "sort", "toSorted",
]);

/** Array methods returning the same elements, so a chain off them is still a collection of the element. */
export const KEEPS_ELEMENTS: ReadonlySet<string> = new Set(["filter", "slice", "sort", "toSorted", "reverse", "toReversed", "concat", "splice"]);
