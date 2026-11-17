import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";

/**
 * The regex reading's counterpart of the ANTLR front end's Qt slot passes (antlr.ts `connectReferences`): a function
 * that wires `connect(save, SIGNAL(clicked()), this, SLOT(saveClub(int)))` or `connect(save, &QPushButton::clicked,
 * this, &ClubWindow::saveClub)` hands the slot on — it never calls it. The `SLOT(saveClub(int))` macro reads as a call
 * of `saveClub` to the line scan, which this marks `passed: "argument"`; a pointer-to-member argument after the
 * signal (`&ClubWindow::saveClub`) is added as a passed name spelled as a static call of it would be
 * (`ClubWindow.saveClub`, receiver type `ClubWindow`), a bare `&saveClub` as `saveClub`.
 *
 * `code` is the file's lines with comments and strings blanked; `fns` carry `line`/`endLine` (1-based).
 */
export function markQtSlotPasses(code: readonly string[], fns: readonly FunctionInfo[]): void {
  for (const fn of fns) {
    if (fn.line < 1 || fn.endLine < fn.line) continue;
    const first = fn.line - 1;
    const last = Math.min(fn.endLine, code.length) - 1;
    const slice = code.slice(first, last + 1);
    if (!slice.some((l) => l.includes("SLOT") || l.includes("connect"))) continue;
    const body = slice.join("\n");
    const lineStarts: number[] = [];
    let offset = 0;
    for (const l of slice) {
      lineStarts.push(offset);
      offset += l.length + 1;
    }
    const position = (at: number): { line: number; column: number } => {
      let row = 0;
      while (row + 1 < lineStarts.length && lineStarts[row + 1]! <= at) row++;
      return { line: first + row + 1, column: at - lineStarts[row]! };
    };
    for (const m of body.matchAll(/(?<![\w.>:])SLOT\s*\(\s*([A-Za-z_]\w*)\s*\(/dg)) {
      const slot = m[1]!;
      const at = position(m.indices![1]![0]);
      const call = fn.calls.find((c) => c.name === slot && !c.receiverType && !c.passed && c.line === at.line);
      if (call) call.passed = "argument";
      else if (!fn.calls.some((c) => c.name === slot && c.passed && c.line === at.line)) fn.calls.push({ name: slot, kind: "internal", target: null, line: at.line, column: at.column, passed: "argument" });
    }
    for (const m of body.matchAll(/(?<![\w.>])(?:[A-Za-z_]\w*::)*connect\s*\(/g)) {
      const open = m.index! + m[0].length - 1;
      for (const arg of argumentsAt(body, open).slice(2)) {
        const text = arg.text.trim();
        const slot = /^&((?:[A-Za-z_]\w*::)*)([A-Za-z_]\w*)$/.exec(text);
        if (!slot) continue;
        const owner = slot[1] ? slot[1].split("::").filter(Boolean).at(-1)! : undefined;
        const named: Pick<CallInfo, "name" | "receiverType"> | null =
          owner && /^[A-Z]/.test(owner) ? { name: `${owner}.${slot[2]}`, receiverType: owner } : owner ? null : { name: slot[2]! };
        if (!named) continue;
        const where = position(arg.at + (arg.text.length - arg.text.trimStart().length));
        if (fn.calls.some((c) => c.name === named.name && c.passed && c.line === where.line && c.column === where.column)) continue;
        fn.calls.push({ ...named, kind: "internal", target: null, line: where.line, column: where.column, passed: "argument" });
      }
    }
  }
}

/** Top-level arguments of the call whose `(` is at `open` in `text`. */
function argumentsAt(text: string, open: number): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        out.push({ text: text.slice(start, i), at: start });
        return out;
      }
    } else if (ch === "," && depth === 1) {
      out.push({ text: text.slice(start, i), at: start });
      start = i + 1;
    }
  }
  return [];
}
