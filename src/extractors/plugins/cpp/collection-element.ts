import { splitTypeArgs } from "../shared/element-chain.js";

/** Standard containers a range-for walks one element at a time (a map yields pairs, never its value alone). */
const CONTAINERS = new Set(["vector", "list", "deque", "forward_list", "set", "multiset", "unordered_set", "unordered_multiset", "array", "span", "initializer_list", "valarray"]);
const SMART_POINTERS = new Set(["shared_ptr", "unique_ptr", "weak_ptr"]);
const WITH_SECOND_ARGUMENT = /^(?:vector|list|deque|forward_list|set|multiset|unordered_set|unordered_multiset|array)$/;

/**
 * The element a declared C++ container type states: `std::vector<Player>`, `const std::array<Player, 11>&`,
 * `vector<Player*>`, `std::list<std::shared_ptr<Player>>` → `Player`. Null for a map, a nested container or an
 * element that is not one class name.
 */
export function cppCollectionElement(type: string | null | undefined, as?: "iterated" | "dereferenced"): string | null {
  const element = cppCollectionElementOf(type);
  // An iterator is its element when that is a value (`it->kick()`); only a pointer element has a pointee (`(*it)->kick()`).
  if (as && element && element.pointer !== (as === "dereferenced")) return null;
  return element?.name ?? null;
}

/** The element of a container type with what holds it: a value, or a raw / smart pointer (`vector<Boot*>`, `vector<unique_ptr<Boot>>`). */
export function cppCollectionElementOf(type: string | null | undefined): { name: string; pointer: boolean } | null {
  const text = strip(type ?? "");
  const m = /^([a-z_]+)\s*<([\s\S]+)>$/.exec(text);
  if (!m || !CONTAINERS.has(m[1]!)) return null;
  const args = splitTypeArgs(m[2]!);
  // `vector<T, Alloc>`, `set<T, Less>`, `array<T, N>`: the first argument is the element.
  if (args.length === 0 || (args.length > 1 && !WITH_SECOND_ARGUMENT.test(m[1]!))) return null;
  return classElement(args[0]!);
}

const MAPS = /^(?:map|multimap|unordered_map|unordered_multimap|flat_map)$/;

/** The key and value classes a declared map type states (`std::map<Boot, Club>` → `Boot`, `Club`); a side that is no class (`std::string`, a pointer) is null. Null for any other type. */
export function cppMapTypes(type: string | null | undefined): { key: string | null; value: string | null } | null {
  const m = /^([a-z_]+)\s*<([\s\S]+)>$/.exec(strip(type ?? ""));
  if (!m || !MAPS.test(m[1]!)) return null;
  const args = splitTypeArgs(m[2]!);
  if (args.length < 2) return null;
  const side = (raw: string): string | null => { const e = classElement(raw); return e && !e.pointer ? e.name : null; };
  return { key: side(args[0]!), value: side(args[1]!) };
}

function strip(raw: string): string {
  return raw.replace(/\b(?:const|volatile|struct|class|typename)\b/g, " ").replace(/\bstd\s*::\s*/g, "").replace(/[&*\s]+$/, "").trim();
}

function classElement(raw: string): { name: string; pointer: boolean } | null {
  let element = strip(raw);
  let pointer = /\*\s*$/.test(raw.replace(/\b(?:const|volatile)\b/g, " ").trim());
  const wrapped = /^([a-z_]+)\s*<([\s\S]+)>$/.exec(element);
  if (wrapped) {
    if (!SMART_POINTERS.has(wrapped[1]!)) return null;
    element = strip(wrapped[2]!);
    pointer = true;
  }
  const ok = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(element)
    && !/^(?:int|long|short|char|bool|float|double|unsigned|signed|void|size_t|string|wstring|u?int\d+_t)$/.test(element);
  return ok ? { name: element.replace(/^::/, ""), pointer } : null;
}
