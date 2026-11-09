import type { FileAnalysis, SymbolLink } from "../types/analysis.js";

/**
 * A write to a reactive cell re-runs the callbacks watching that cell: a handler setting a Vue
 * `ref` runs the `watch` on it, a React `useState` setter the `useEffect` listing the state, an
 * Angular signal's `.set` the `effect` reading it. Each write becomes an INFERRED `dispatch` link
 * from the function writing to each callback on the same cell — the plugin scoped the cell to the
 * component or class declaring it (`FileAnalysis.reactiveCells`), so the join never leaves the file.
 * `callName` is what the write spells (`setClubId`, `pickedClubs`), at the write's line. A switch-off write
 * (`open.value = false`) never runs a callback that runs only when the value turns truthy.
 */
export function reactiveTriggerLinks(analyses: readonly FileAnalysis[]): SymbolLink[] {
  const out: SymbolLink[] = [];
  for (const a of analyses) {
    const cells = a.reactiveCells;
    if (!cells) continue;
    const lineOf = new Map<string, number>();
    for (const f of a.functions) lineOf.set(f.name, f.line);
    for (const c of a.classes) for (const m of c.methods) lineOf.set(`${c.name}.${m.name}`, m.line);
    const triggers = cells.triggers.filter((t) => lineOf.has(t.function));
    const seen = new Set<string>();
    for (const w of cells.writes) {
      if (!lineOf.has(w.function)) continue;
      for (const t of triggers) {
        if (!t.cells.some((c) => sameCell(w.cell, c)) || (t.truthyOnly && w.falsy)) continue;
        if (t.function === w.function) continue;
        const id = `${w.function}\0${w.line}\0${t.function}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          sourceFile: a.filePath,
          sourceSymbol: w.function,
          sourceLine: w.line,
          callName: w.spelling,
          targetFile: a.filePath,
          targetSymbol: t.function,
          targetLine: lineOf.get(t.function)!,
          confidence: "INFERRED",
          strategy: "dispatch:reactive-trigger",
          relation: "dispatch",
        });
      }
    }
  }
  return out;
}

/**
 * Whether a write re-runs what watches a cell. A write lands on a path (`12:filters.league`, an element
 * `12:picked.[]`); a read is a path too, marked `*` when it reads through what it reaches (`12:picked*`: a
 * reactive object watched whole, a list iterated). The write re-runs the read when it replaces what the read
 * reaches or a member above it, or — for a read through — anything below it.
 */
export function sameCell(write: string, read: string): boolean {
  const deep = read.endsWith("*");
  const r = deep ? read.slice(0, -1) : read;
  return write === r || r.startsWith(`${write}.`) || (deep && write.startsWith(`${r}.`));
}
