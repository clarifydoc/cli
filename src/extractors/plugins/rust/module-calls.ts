import type { CallInfo, FileAnalysis } from "../../../types/analysis.js";
import { blockEndLine } from "../shared/regex-base.js";
import { rustSpec } from "./index.js";

/**
 * Calls through a module path, named as written (`tools::wrench`,
 * `crate::garage::tools::spanner`, `super::load`, `util::fmt::score`): each is
 * a call of the function `member` in the module its path names, which the
 * plugin's import rules resolve (module-resolver.ts) — so `target` is that
 * path, with a head the file brings in by name (`mod tools;`, `use
 * crate::garage::tools;`) spelled out through its import (`self::tools`,
 * `crate::garage::tools`). A path from a crate the analysis lacks (`std::mem`)
 * resolves to no file and links nothing.
 */
export function promoteModuleCalls(analysis: FileAnalysis, lines: string[]): void {
  const inline = inlineModuleSpans(lines);
  const imported = new Map<string, string>();
  for (const imp of analysis.imports) {
    for (const s of imp.specifiers) {
      if (imported.has(s)) continue;
      const name = imp.aliases?.[s] ?? s;
      imported.set(s, imp.source === "self" ? `self::${name}` : `${imp.source}::${name}`);
    }
  }
  const promote = (calls: CallInfo[]) => {
    for (const c of calls) {
      if (c.kind !== "internal" || c.name.includes(".") || !c.name.includes("::")) continue;
      const cut = c.name.lastIndexOf("::");
      const path = c.name.slice(0, cut);
      const member = c.name.slice(cut + 2);
      let segs = path.split("::");
      // Inside `mod tests { … }` (and deeper inline modules) `super` climbs those first:
      // `super::helper()` there is the file's own `helper`.
      const depth = inline.filter(([from, to]) => c.line > from && c.line <= to).length;
      if (depth > 0 && segs[0] === "super") {
        let ups = 0;
        while (segs[ups] === "super") ups++;
        segs = ups <= depth ? ["self", ...segs.slice(ups)] : [...segs.slice(depth)];
      }
      const head = segs[0]!;
      const through = head === "crate" || head === "super" || head === "self" ? undefined : imported.get(head);
      c.kind = "cross-file";
      c.target = through ? [through, ...segs.slice(1)].join("::") : segs.join("::");
      c.member = member;
      c.confidence = "EXTRACTED";
    }
  };
  for (const fn of analysis.functions) promote(fn.calls);
  for (const cls of analysis.classes) for (const m of cls.methods) promote(m.calls);
}

/** Lines `[declared, closed]` of each inline module (`mod tests { … }`), 1-based. */
function inlineModuleSpans(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?:r#)?\w+\s*\{/.test(lines[i]!)) spans.push([i + 1, blockEndLine(lines, i, rustSpec)]);
  }
  return spans;
}
