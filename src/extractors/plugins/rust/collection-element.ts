import { splitTypeArgs } from "../shared/element-chain.js";

const REFERENCE = /^(?:&\s*(?:'\w+\s+)?(?:mut\s+)?)+/;

/**
 * The element a declared Rust collection type states: `Vec<Player>`, `&[Player]`, `&mut Vec<Player>`,
 * `[Player; 11]`, `VecDeque<&Player>`, `Box<[Player]>`, `HashSet<Player>` → `Player`. Null for a map, an option or
 * any element that is not one type path.
 */
export function rustCollectionElement(type: string | null | undefined): string | null {
  const t = (type ?? "").trim().replace(REFERENCE, "").trim();
  if (t.startsWith("[")) {
    if (!t.endsWith("]")) return null;
    const inner = t.slice(1, -1);
    const semi = inner.lastIndexOf(";");
    return classOf(semi >= 0 ? inner.slice(0, semi) : inner);
  }
  const m = /^(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*<([\s\S]+)>$/.exec(t);
  if (!m) return null;
  const args = splitTypeArgs(m[2]!);
  if (m[1] === "Box" || m[1] === "Rc" || m[1] === "Arc") return args.length === 1 && args[0]!.trim().startsWith("[") ? rustCollectionElement(args[0]) : null;
  if (!/^(?:Vec|VecDeque|HashSet|BTreeSet|BinaryHeap|LinkedList)$/.test(m[1]!) || args.length < 1) return null;
  return classOf(args[0]!);
}

function classOf(raw: string): string | null {
  const t = raw.trim().replace(REFERENCE, "").trim();
  return /^(?:[A-Za-z_]\w*::)*[A-Z]\w*$/.test(t) ? t : null;
}
