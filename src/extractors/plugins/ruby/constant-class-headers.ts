/**
 * A constant naming a class a call builds — `Score = Struct.new(…) do … end`, `Data.define(…)`,
 * `Striker = Class.new(Club)` — read by the one-line class patterns. A header that wraps
 * (`Transfer = Struct.new(\n  :player,\n  :fee\n) do`), whose `do` sits on a later line, or that has no
 * block at all, is joined onto its first line so the pattern sees the statement whole; the lines it spanned
 * are blanked, so every line number stays.
 */

const HEADER = /^(\s*(?:::)?[A-Z]\w*(?:::[A-Z]\w*)*\s*=\s*(?:Struct\.new|Data\.define|Class\.new)\b)/;
const OPENS_BLOCK = /(?:\bdo(?:\s*\|[^|]*\|)?|\{(?:\s*\|[^|]*\|)?)\s*$/;

/** Net `(` minus `)` of a line's code (strings and comments are not read: a header's arguments are symbols and constants). */
function parenDelta(text: string): number {
  let delta = 0;
  for (const ch of text.replace(/#.*$/, "")) {
    if (ch === "(") delta++;
    else if (ch === ")") delta--;
  }
  return delta;
}

/** `lines` with each wrapped or block-less constant class header joined onto its first line; the same array when none is. */
export function joinConstantClassHeaders(lines: string[]): string[] {
  let out: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const first = lines[i]!;
    if (!HEADER.test(first) || OPENS_BLOCK.test(first)) continue;
    let depth = 0;
    let end = i;
    let text = first.replace(/(?:^|\s)#.*$/, "").replace(/\s*\\\s*$/, "");
    depth += parenDelta(first);
    while ((depth > 0 || /[,\\]\s*$/.test(lines[end]!)) && end + 1 < lines.length && end - i < 12) {
      end++;
      text += " " + lines[end]!.replace(/(?:^|\s)#.*$/, "").trim().replace(/\s*\\\s*$/, "");
      depth += parenDelta(lines[end]!);
    }
    if (depth !== 0) continue;
    // `do` / `{` alone on the next line continues the statement.
    if (!OPENS_BLOCK.test(text) && end + 1 < lines.length && /^\s*do\b/.test(lines[end + 1]!)) {
      end++;
      text += " " + lines[end]!.trim();
    }
    if (!OPENS_BLOCK.test(text)) {
      // No block: only `Class.new(Base)` alone names a class (a `Struct.new` without a block is the record the
      // macro pass reads from its own line). A trailing `{ }` gives the class pattern its block.
      if (!/=\s*Class\.new\(\s*(?:::)?[A-Z][\w:]*\s*\)\s*$/.test(text)) continue;
      text += " { }";
    }
    if (end === i && text === first) continue;
    out ??= [...lines];
    out[i] = text;
    for (let k = i + 1; k <= end; k++) out[k] = "";
    i = end;
  }
  return out ?? lines;
}
