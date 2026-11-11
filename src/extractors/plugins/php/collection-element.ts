import { collectionElementText } from "../../shared/collection-element.js";
import { splitTypeArgs } from "../shared/element-chain.js";

/**
 * The element a declared PHP collection type states: `Player[]`, `array<int, Player>`, `list<Player>`,
 * `iterable<Player>`, `Collection<int, Player>`, `\App\Player[]`, `?Player[]` → `Player`. Null for a plain array
 * (`array`), a map keyed by a string, a union or an element that is not one class name.
 */
export function phpCollectionElement(type: string | null | undefined): string | null {
  const text = (type ?? "").trim().replace(/^\?/, "").replace(/^non-empty-/, "");
  const m = /^\\?([A-Za-z_][\w\\]*)\s*<([\s\S]+)>$/.exec(text);
  if (m) {
    const name = m[1]!.split("\\").pop()!;
    const args = splitTypeArgs(m[2]!);
    if (/^(?:list|iterable|Collection|Enumerable|Traversable|Generator|ArrayObject|array)$/.test(name)) {
      const keyed = args.length === 2 && /^(?:int|positive-int|non-negative-int)$/.test(args[0]!);
      if (args.length === 1 || keyed) return phpClass(args[args.length - 1]!);
    }
    return null;
  }
  const element = collectionElementText(text);
  return element ? phpClass(element) : null;
}

function phpClass(raw: string): string | null {
  const t = raw.trim().replace(/^\?/, "");
  const scalar = /^(?:int|string|float|bool|array|mixed|object|callable|iterable|null|void|self|static|true|false)$/i;
  return /^\\?[A-Za-z_][\w\\]*$/.test(t) && !scalar.test(t) ? t : null;
}
