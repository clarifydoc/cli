/**
 * The call sites of one function body in the order they run, read off its
 * source text: `save(build(make()))` is make, build, save — an argument before
 * the call receiving it, a chain left to right — because a call finishes where
 * its parentheses close. The extractors keep one row per callee and the linker
 * one link per caller and callee, so a repeat of a call, or the order of
 * several calls on one line, is not in them; the text is.
 *
 * On demand, like the sequence itself; the links say what each name reaches,
 * this says where and in which order the body spells it.
 */

export interface CallSite {
  /** The name before the `(`. */
  name: string;
  line: number;
  column: number;
  /** Where the call finishes (its closing parenthesis): the order a call runs in. */
  endLine: number;
  endColumn: number;
  /** The call is awaited (`await save()`, `save().await`). */
  awaited: boolean;
}

/** Strings and comments blanked to spaces, newlines and offsets kept. */
function blanked(text: string): string {
  const out = text.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      let end = text.indexOf("\n", i);
      if (end < 0) end = text.length;
      blank(i, end);
      i = end;
    } else if (c === "/" && next === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end < 0 ? text.length : end + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && (c === "`" || text[j] !== "\n")) j += text[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

const IDENT = /[\w$]/;

/** The start of the receiver chain a call at `start` ends: `repo.find().load` → where `repo` begins. */
function chainStart(t: string, start: number): number {
  let i = start;
  for (;;) {
    let j = i;
    while (j > 0 && /\s/.test(t[j - 1]!)) j--;
    if (t[j - 1] !== ".") return i;
    j--;
    if (t[j - 1] === "?") j--;
    while (j > 0 && /\s/.test(t[j - 1]!)) j--;
    let moved = false;
    while (j > 0 && (t[j - 1] === ")" || t[j - 1] === "]")) {
      let depth = 0;
      let k = j - 1;
      for (; k >= 0; k--) {
        if (t[k] === ")" || t[k] === "]") depth++;
        else if (t[k] === "(" || t[k] === "[") if (--depth === 0) break;
      }
      if (k < 0) return i;
      j = k;
      moved = true;
      while (j > 0 && /\s/.test(t[j - 1]!)) j--;
    }
    const identEnd = j;
    while (j > 0 && IDENT.test(t[j - 1]!)) j--;
    if (j === identEnd && !moved) return i;
    i = j;
  }
}

/** The call sites of lines `from`..`to` (1-based) of a file, in the order they finish. */
export function callSitesIn(lines: readonly string[], from: number, to: number): CallSite[] {
  const slice = lines.slice(Math.max(0, from - 1), to);
  const text = blanked(slice.join("\n"));
  const starts: number[] = [];
  let off = 0;
  for (const l of slice) {
    starts.push(off);
    off += l.length + 1;
  }
  const where = (offset: number): { line: number; column: number } => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: from + lo, column: offset - starts[lo]! };
  };
  const sites: Array<CallSite & { key: number }> = [];
  const re = /([A-Za-z_$][\w$]*)[ \t]*\(/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = text.length - 1;
    for (let k = open; k < text.length; k++) {
      if (text[k] === "(") depth++;
      else if (text[k] === ")" && --depth === 0) {
        close = k;
        break;
      }
    }
    const begin = where(m.index);
    const end = where(close);
    // Awaited: the chain this call ends is introduced by `await` and nothing follows it in the chain.
    const before = text.slice(0, chainStart(text, m.index)).replace(/[\s(]+$/, "");
    const after = text.slice(close + 1);
    const awaited = (/(^|[^\w$.])await$/.test(before) && !/^\s*\??\.\s*[A-Za-z_$]/.test(after)) || /^\s*\.await\b/.test(after);
    sites.push({ name: m[1]!, line: begin.line, column: begin.column, endLine: end.line, endColumn: end.column, awaited, key: close });
  }
  return sites.sort((a, b) => a.key - b.key).map(({ key: _key, ...site }) => site);
}

/** The last name a call is written with: `repo.find().load` → `load`, `new Club` → `Club`. */
export function leafName(callName: string): string {
  const cleaned = callName.replace(/\(.*$/s, "").replace(/^new\s+/, "").trim();
  return cleaned.slice(cleaned.lastIndexOf(".") + 1);
}
