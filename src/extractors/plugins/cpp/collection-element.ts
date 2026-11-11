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
export function cppCollectionElement(type: string | null | undefined): string | null {
  const text = strip(type ?? "");
  const m = /^([a-z_]+)\s*<([\s\S]+)>$/.exec(text);
  if (!m || !CONTAINERS.has(m[1]!)) return null;
  const args = splitTypeArgs(m[2]!);
  // `vector<T, Alloc>`, `set<T, Less>`, `array<T, N>`: the first argument is the element.
  if (args.length === 0 || (args.length > 1 && !WITH_SECOND_ARGUMENT.test(m[1]!))) return null;
  return classElement(args[0]!);
}

function strip(raw: string): string {
  return raw.replace(/\b(?:const|volatile|struct|class|typename)\b/g, " ").replace(/\bstd\s*::\s*/g, "").replace(/[&*\s]+$/, "").trim();
}

function classElement(raw: string): string | null {
  let element = strip(raw);
  const wrapped = /^([a-z_]+)\s*<([\s\S]+)>$/.exec(element);
  if (wrapped) {
    if (!SMART_POINTERS.has(wrapped[1]!)) return null;
    element = strip(wrapped[2]!);
  }
  const ok = /^(?:::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(element)
    && !/^(?:int|long|short|char|bool|float|double|unsigned|signed|void|size_t|string|wstring|u?int\d+_t)$/.test(element);
  return ok ? element.replace(/^::/, "") : null;
}
