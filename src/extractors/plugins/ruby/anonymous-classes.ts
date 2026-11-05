import type { FunctionInfo } from "../../../types/analysis.js";

/**
 * An anonymous subclass a spec builds on the spot — `klass = Class.new(Club)`, with or without a block
 * of overrides. Its instances answer everything `Club` does (but for the methods the block defines), so
 * `klass.new.close` and `inst = klass.new; inst.close` are calls through `Club`: the call carries that
 * receiver type, as `Club.new.close` does.
 */

const CONST = String.raw`[A-Z]\w*(?:::[A-Z]\w*)*`;
const DECLARES = new RegExp(String.raw`^\s*([a-z_]\w*)\s*=\s*Class\.new\(\s*(?:::)?(${CONST})\s*\)\s*(\{|\bdo\b)?`);
const ARGS = String.raw`(?:\((?:[^()]|\([^()]*\))*\))?`;

interface Anonymous { base: string; overrides: Set<string> }

/** The anonymous classes `lines` (the function's own code, one entry per line from `from`) declare, with the methods each one's block defines. */
function declared(lines: readonly string[], whole: readonly string[], from: number, to: number): Map<string, Anonymous> {
  const out = new Map<string, Anonymous>();
  for (let i = from; i < to; i++) {
    const m = DECLARES.exec(lines[i] ?? "");
    if (!m) continue;
    const overrides = new Set<string>();
    if (m[3]) {
      // The block runs to the first later line indented no deeper than the declaration's (its `end`/`}`).
      const indent = /^\s*/.exec(lines[i]!)![0].length;
      for (let j = i + 1; j < whole.length; j++) {
        const text = whole[j] ?? "";
        if (text.trim() && /^\s*/.exec(text)![0].length <= indent) break;
        const def = /^\s*def\s+(?:self\.)?([a-z_]\w*[?!=]?)/.exec(text);
        if (def) overrides.add(def[1]!);
      }
    }
    // A name rebound to anything else is not one anonymous class: neither reading is kept.
    if (out.has(m[1]!)) out.delete(m[1]!);
    else out.set(m[1]!, { base: m[2]!, overrides });
  }
  return out;
}

/** Calls on instances (`whole`: the file's code, where a block's own `def`s are still written)  of an anonymous subclass, and the locals holding one, onto `fn`. */
export function addAnonymousClassCalls(lines: readonly string[], fn: FunctionInfo, whole: readonly string[] = lines): void {
  const from = fn.line - 1;
  const to = Math.min(fn.endLine, lines.length);
  if (!lines.slice(from, to).some((l) => l.includes("Class.new("))) return;
  const classes = declared(lines, whole, from, to);
  if (classes.size === 0) return;
  const names = [...classes.keys()].join("|");
  const direct = new RegExp(String.raw`(?<![\w.@$:])(${names})\.new\b${ARGS}\.([a-z_]\w*[?!]?)(?![\w?!])`, "g");
  const built = new RegExp(String.raw`^\s*([a-z_]\w*)\s*=\s*(${names})\.new\b${ARGS}\s*$`);
  const have = new Set(fn.calls.map((c) => `${c.name}@${c.line}`));
  for (let i = from; i < to; i++) {
    const code = (lines[i] ?? "").replace(/\s#.*$/, "");
    for (const m of code.matchAll(direct)) {
      const anon = classes.get(m[1]!)!;
      const key = `new.${m[2]}@${i + 1}`;
      if (anon.overrides.has(m[2]!) || have.has(key)) continue;
      have.add(key);
      fn.calls.push({ name: `new.${m[2]}`, kind: "internal", target: null, line: i + 1, receiverType: anon.base });
    }
    const local = built.exec(code);
    // An instance of a class with overrides is typed by nothing: any member may be the block's.
    if (local && classes.get(local[2]!)!.overrides.size === 0 && !fn.localTypes?.some((l) => l.name === local[1])) {
      (fn.localTypes ??= []).push({ name: local[1]!, type: classes.get(local[2]!)!.base });
    }
  }
}
