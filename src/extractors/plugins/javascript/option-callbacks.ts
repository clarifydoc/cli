import type { FileAnalysis, FunctionPropBinding } from "../../../types/analysis.js";

/**
 * Callbacks handed to a component the SCRIPT mounts or opens — the options object of a call whose
 * first argument is an imported component: `modal.open(ConfirmBox, { onConfirm: saveClub })`,
 * `h(ClubForm, { onSave: () => store.dispatch('club/save') })`, `open(Dialog, { props: { onClose } })`.
 * The child reads them as its props (`props.onConfirm()`), so they are `FunctionPropBinding`s with
 * the import the component came from. A function named is bound by name; an inline arrow is not a
 * symbol of its own, so it binds the function the call sits in, whose calls include the arrow's.
 * Only `on[A-Z]…` keys count (React and Vue's callback convention), only at the top of the options or
 * inside the usual props wrapper, and only when the component is an import — a name the file does
 * not import is never guessed.
 */
export function extractOptionCallbacks(script: string, analysis: FileAnalysis): FunctionPropBinding[] {
  if (!/\bon[A-Z]\w*\s*[:,}(]/.test(script)) return [];
  const imported = new Map<string, string>();
  for (const imp of analysis.imports) for (const s of imp.specifiers) imported.set(s, imp.source);
  if (imported.size === 0) return [];
  const code = blank(script);
  const lineAt = (offset: number) => {
    let n = 1;
    for (let i = code.indexOf("\n"); i >= 0 && i < offset; i = code.indexOf("\n", i + 1)) n++;
    return n;
  };
  const own = new Set([...analysis.functions, ...analysis.classes.flatMap((c) => c.methods)].map((f) => f.name.split(".").pop()!));
  const enclosing = (line: number) => {
    let best: { name: string; span: number } | null = null;
    for (const f of analysis.functions) {
      if (f.name === "<setup>" || line < f.line || line > f.endLine) continue;
      const span = f.endLine - f.line;
      if (!best || span < best.span) best = { name: f.name, span };
    }
    return best?.name ?? null;
  };
  const out: FunctionPropBinding[] = [];
  const callRe = /(?:^|[^\w$.])(?:[\w$]+(?:\.[\w$]+)*)\s*\(\s*([A-Z][\w$]*)\s*,\s*(?=\{)/g;
  for (let m = callRe.exec(code); m; m = callRe.exec(code)) {
    const component = m[1]!;
    const importSource = imported.get(component);
    if (!importSource) continue;
    const objStart = m.index + m[0].length;
    const objEnd = matching(code, objStart);
    if (objEnd < 0) continue;
    const walk = (from: number, to: number, depth: number): void => {
      for (const e of entriesOf(code, from, to)) {
        const brace = e.valueStart + (code.slice(e.valueStart, e.valueEnd).length - code.slice(e.valueStart, e.valueEnd).trimStart().length);
        if (depth === 0 && PROPS_KEYS.has(e.key) && code[brace] === "{") {
          const end = matching(code, brace);
          if (end > 0) walk(brace, end, 1);
          continue;
        }
        if (!/^on[A-Z]\w*$/.test(e.key)) continue;
        const value = code.slice(e.valueStart, e.valueEnd).trim();
        const at = lineAt(e.valueStart);
        let handler: string | null = null;
        if (e.shorthand) handler = own.has(e.key) ? e.key : null;
        else if (/^[A-Za-z_$][\w$]*$/.test(value)) handler = own.has(value) ? value : null;
        else if (/^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>|^(?:async\s+)?function\b|^(?:async\s+)?[\w$]*\s*\([^()]*\)\s*\{/.test(value)) handler = enclosing(at);
        if (handler) out.push({ component, prop: e.key, handler, line: at, importSource });
      }
    };
    walk(objStart, objEnd, 0);
  }
  return out;
}

const PROPS_KEYS = new Set(["props", "componentProps", "propsData", "attrs"]);

interface Entry {
  key: string;
  shorthand: boolean;
  valueStart: number;
  valueEnd: number;
}

/** The `key: value` entries one level inside the object between `from` ({) and `to` (}). */
function entriesOf(code: string, from: number, to: number): Entry[] {
  const out: Entry[] = [];
  let depth = 0;
  let start = from + 1;
  const flush = (end: number) => {
    const piece = code.slice(start, end);
    const lead = piece.length - piece.trimStart().length;
    const km = /^([A-Za-z_$][\w$]*)\s*(:|,|$|\()/.exec(piece.trimStart());
    if (km) {
      if (km[2] === ":") {
        const vs = start + lead + km[0].length;
        out.push({ key: km[1]!, shorthand: false, valueStart: vs, valueEnd: end });
      } else if (km[2] === "(") out.push({ key: km[1]!, shorthand: false, valueStart: start + lead, valueEnd: end });
      else out.push({ key: km[1]!, shorthand: true, valueStart: start + lead, valueEnd: end });
    }
    start = end + 1;
  };
  for (let i = from + 1; i < to; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) flush(i);
  }
  flush(to);
  return out;
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The script with comments and string contents replaced by spaces, offsets kept. */
function blank(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") out += " ", i++;
      i--;
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop - 1;
    } else if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += c + src.slice(i + 1, j).replace(/[^\n]/g, " ") + (j < src.length ? c : "");
      i = j;
    } else out += c;
  }
  return out;
}
