import type { CallPattern } from "./regex-base.js";

/** A call's balanced argument list, one nesting level deep (strings are blanked before patterns run). */
const ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;

/**
 * Call patterns naming a method called on what a call returns —
 * `graceful.GetManager().Shutdown()`, `Club::new(id).register()` — as the
 * chain, one to `maxDepth` calls deep (`a.B().C().D` names `D` on what `C`
 * returns). The baseline drops these: it cannot name the receiver, and a bare
 * leaf would let any same-named function capture it. Written as the chain,
 * the linker types each step through the declared return types and binds the
 * method only when every step resolves.
 *
 * `head` is the chain's first callee as a regex source with ONE capture group
 * (a function, a package member, a `Type::` path), anchored so it is never the
 * tail of a longer selector; `headName` respells it as the linker reads names
 * (`Club::new` → `Club.new`).
 */
export function callChainPatterns(head: string, headName: (raw: string) => string = (raw) => raw, maxDepth = 3): CallPattern[] {
  const patterns: CallPattern[] = [];
  for (let depth = 1; depth <= maxDepth; depth++) {
    const steps = String.raw`\.([A-Za-z_]\w*)\s*${ARGS}`.repeat(depth - 1);
    patterns.push({
      pattern: new RegExp(head + String.raw`\s*` + ARGS + steps + String.raw`\.([A-Za-z_]\w*)\s*\(`, "g"),
      buildName: (m) => {
        const parts = m.slice(1).filter((x): x is string => x !== undefined);
        const leafName = parts[parts.length - 1]!;
        const calls = [headName(parts[0]!), ...parts.slice(1, -1)].map((p) => `${p}()`).join(".");
        return { name: `${calls}.${leafName}`, leafName };
      },
    });
  }
  return patterns;
}
