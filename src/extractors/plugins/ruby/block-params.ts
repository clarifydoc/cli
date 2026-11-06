import type { FunctionInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * The parameter a block hands its body: `clubs.each { |club| … }`, `team.players.map do |player| … end`.
 * Ruby states no type for it, so a call on it (`club.save`) is one on a value of unknown type — the
 * linker must not guess that it is the project's one `save`. The element type IS stated when the
 * collection is: `team.players` (a `has_many :players` reader) holds `Player`s, and so does a model
 * query (`Club.where(…)`). Then the parameter's initializer is the first element of that chain
 * (`localTypes[].from`), which the linker types from the declared readers like any local.
 */

/** Iterators whose block's FIRST parameter is one element of the receiver. */
const ELEMENT_ITERATORS = [
  "each", "map", "collect", "flat_map", "select", "filter", "reject", "find", "detect", "find_all", "filter_map",
  "each_with_index", "each_with_object", "sort_by", "group_by", "partition", "min_by", "max_by", "sum", "count",
  "any?", "all?", "none?", "find_each", "each_entry", "take_while", "drop_while", "uniq", "tally_by", "each_slice_flat",
].map(escapeRegex);

/** `<receiver chain>.each { |x|` / `… do |x, i|` — the receiver up to four steps, arguments one level deep. */
const STEP = String.raw`[a-z_]\w*[?!]?(?:\((?:[^()]|\([^()]*\))*\))?`;
const BLOCK_RE = new RegExp(
  String.raw`(?<![\w.@$:])((?:[A-Z]\w*(?:::[A-Z]\w*)*|[a-z_]\w*[?!]?)(?:\.${STEP}){0,4}?)\.(?:${ELEMENT_ITERATORS.join("|")})(?:\((?:[^()]|\([^()]*\))*\))?\s*(?:\{|\bdo\b)\s*\|\s*\(?\s*([a-z_]\w*)`,
  "g",
);

export interface BlockParam {
  name: string;
  /** The first element of the iterated collection as a call chain (`team.players().first()`), when the collection is typed. */
  from?: string;
}

/** `team.players(x).where(y)` → `team.players().where()`: the head as written, every later step a call, arguments dropped. */
function asCallChain(chain: string): string {
  const steps: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of chain) {
    if (ch === "(") { depth++; continue; }
    if (ch === ")") { depth--; continue; }
    if (depth > 0) continue;
    if (ch === ".") { steps.push(cur); cur = ""; continue; }
    cur += ch;
  }
  steps.push(cur);
  return steps.map((st, i) => (i === 0 ? st : `${st}()`)).join(".");
}

/**
 * Block parameters of the function, each with the element chain it can be typed by. `typedHeads`
 * are the names whose type the function states (a typed local, an association reader of the
 * class) and `finder` tells a class-level model query from any other chain.
 */
export function blockParamsOf(
  codeLines: ReadonlyArray<readonly [number, string]>,
  typedHeads: ReadonlySet<string>,
  isFinderChain: (callChain: string) => boolean,
): BlockParam[] {
  const out = new Map<string, BlockParam>();
  for (const [, text] of codeLines) {
    const code = text.replace(/\s#.*$/, "");
    if (!code.includes("|")) continue;
    for (const m of code.matchAll(BLOCK_RE)) {
      const recv = m[1]!;
      const name = m[2]!;
      const chain = asCallChain(recv);
      const head = recv.split(".")[0]!.replace(/[?!]$/, "");
      const steps = chain.split(".").length;
      const typed = /^[A-Z]/.test(head) ? isFinderChain(chain) : typedHeads.has(head) && steps >= 2;
      const next: BlockParam = typed ? { name, from: `${chain}.first()` } : { name };
      const prev = out.get(name);
      // One name, one reading: a name iterated over two collections is typed by neither.
      out.set(name, prev && prev.from !== next.from ? { name } : prev ?? next);
    }
  }
  return [...out.values()];
}
