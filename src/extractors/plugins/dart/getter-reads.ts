import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * A getter is read like a field (`squadSize`, `this.squadSize`, `club.badge`), so the call scan sees no call. This
 * marks each getter the file declares (`FunctionInfo.getter`) and records the reads that may run one — a bare name,
 * `this.x`, `receiver.x` — as `CallInfo.read: "getter"`: the linker keeps one only where it resolves, through the
 * reading class and its bases or the receiver's declared type, to a function marked as a getter, so a field, a
 * parameter or a getter of another class draws no edge. Read off the text, so both front ends state the same shapes.
 */
export function addGetterReads(lines: readonly string[], analysis: FileAnalysis): void {
  const fns = new Set<FunctionInfo>(analysis.functions);
  const fieldsOf = new Map<FunctionInfo, ReadonlySet<string>>();
  for (const cls of analysis.classes) {
    const fields = new Set(cls.properties.filter((p) => !p.accessor).map((p) => p.name));
    for (const m of cls.methods) {
      fns.add(m);
      fieldsOf.set(m, fields);
    }
  }
  const code = codeView(lines);
  for (const fn of fns) {
    const name = simpleName(fn.name);
    for (const m of (lines[fn.line - 1] ?? "").matchAll(GETTER_HEAD)) if (m[1] === name) fn.getter = true;
  }
  for (const fn of fns) {
    if (fn.name === "<setup>" || fn.line < 1) continue;
    const body = bodyOf(code, fn);
    if (!body) continue;
    const text = body.text;
    const own = new Set([...declaredNames(text), ...fn.params.map((p) => p.name)]);
    const fields = fieldsOf.get(fn);
    const have = new Set(fn.calls.map((c) => c.name));
    const found: Array<{ name: string; at: number }> = [];
    for (const m of text.matchAll(MEMBER_READ)) {
      const [, head, member] = m;
      const at = m.index!;
      if (head !== "this" && KEYWORDS.has(head!)) continue;
      if (head === "this" ? fields?.has(member!) : STDLIB_MEMBERS.has(member!)) continue;
      if (!isRead(text, at + m[0].length, at)) continue;
      found.push({ name: `${head}.${member}`, at });
    }
    for (const m of text.matchAll(BARE_READ)) {
      const name = m[1]!;
      if (KEYWORDS.has(name) || own.has(name) || fields?.has(name)) continue;
      if (!isRead(text, m.index! + name.length, m.index!)) continue;
      found.push({ name, at: m.index! });
    }
    for (const { name, at } of found.sort((a, b) => a.at - b.at)) {
      if (have.has(name)) continue;
      have.add(name);
      const where = body.position(at);
      const call: CallInfo = { name, kind: "internal", target: null, line: where.line, column: where.column, read: "getter" };
      fn.calls.push(call);
    }
  }
}

/** `get name` on a declaration line. */
const GETTER_HEAD = /(?<![\w$.])get\s+([A-Za-z_$][\w$]*)(?![\w$])/g;
/** `this.x` / `receiver.x`, not itself a call. */
const MEMBER_READ = /(?<![\w$.@])([a-z_$][\w$]*)\s*\.\s*([a-z_$][\w$]*)(?![\w$])(?!\s*[(<])/g;
/** A lowercase name not after a dot and not called. */
const BARE_READ = /(?<![\w$.@])([a-z_$][\w$]*)(?![\w$])(?!\s*[(<])/g;

const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract", "as", "assert", "async", "await", "break", "case", "catch", "class", "const", "continue", "covariant", "default", "deferred", "do",
  "dynamic", "else", "enum", "export", "extends", "extension", "external", "factory", "false", "final", "finally", "for", "get", "hide", "if",
  "implements", "import", "in", "interface", "is", "late", "library", "mixin", "new", "null", "on", "operator", "part", "required", "rethrow",
  "return", "sealed", "set", "show", "static", "super", "switch", "sync", "this", "throw", "true", "try", "typedef", "var", "void", "while",
  "with", "yield", "int", "double", "num", "bool", "String", "List", "Map", "Set", "Future", "Stream", "Object", "Function", "base",
]);

/** Properties every Dart value has; never a getter of the project's. */
const STDLIB_MEMBERS: ReadonlySet<string> = new Set([
  "length", "isEmpty", "isNotEmpty", "first", "last", "single", "hashCode", "runtimeType", "keys", "values", "entries", "reversed", "iterator",
]);

const simpleName = (name: string): string => name.slice(name.lastIndexOf(".") + 1);

/**
 * Whether the name ending at `end` (starting at `start`) is read: not the target of an assignment, a named
 * argument or a label.
 */
function isRead(text: string, end: number, start: number): boolean {
  const rest = text.slice(end).trimStart();
  if (/^(?:[-+*\/~%&|^?]|<<|>>>?|\?\?)?=(?![=>])/.test(rest) && !rest.startsWith("==")) return false;
  if (/^(?:\+\+|--)/.test(rest)) return false;
  if (rest.startsWith(":") && !rest.startsWith("::")) {
    const before = text.slice(0, start).trimEnd();
    if (/[(,{]$/.test(before)) return false;
  }
  return true;
}

/** Names the body declares: variables, loop and catch variables, lambda parameters. */
function declaredNames(text: string): Set<string> {
  const out = new Set<string>();
  const add = (list: string | undefined) => {
    for (const n of (list ?? "").split(",")) {
      const name = /([A-Za-z_$][\w$]*)\s*$/.exec(n.trim())?.[1];
      if (name) out.add(name);
    }
  };
  for (const m of text.matchAll(/\b(?:final|var|const|late)\s+(?:[A-Za-z_$][\w$.]*(?:<[^;(){}=]*?>)?\??\s+)?([A-Za-z_$][\w$]*)\s*(?=[=;,)]|\bin\b)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/(?<![\w$.])[A-Z][\w$.]*(?:<[^;(){}=]*?>)?\??\s+([A-Za-z_$][\w$]*)\s*(?=[=;,)]|\bin\b)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\bcatch\s*\(\s*([\w$]+)(?:\s*,\s*([\w$]+))?\s*\)/g)) { out.add(m[1]!); if (m[2]) out.add(m[2]); }
  for (const m of text.matchAll(/(?<![\w$]\s*)\(([\w$\s,<>?.]*)\)\s*(?:async\s*)?(?:=>|\{)/g)) add(m[1]);
  for (const m of text.matchAll(/(?<![\w$.])([a-z_$][\w$]*)\s*=>/g)) out.add(m[1]!);
  return out;
}

/** The function's body from the end of its declaration head (past the parameters), with a way back to line and column. */
function bodyOf(code: CodeView, fn: FunctionInfo): { text: string; position(at: number): { line: number; column: number } } | null {
  const from = code.offsetOf(fn.line, 0);
  const to = code.offsetOf(fn.endLine + 1, 0);
  if (from < 0) return null;
  const slice = code.text.slice(from, to < 0 ? undefined : to);
  // Past the parameter list: the first `=>` or `{` at parenthesis depth zero after the name's own parentheses.
  const name = simpleName(fn.name);
  let i = firstWord(slice, name);
  if (i < 0) i = 0;
  let depth = 0;
  let start = -1;
  for (let k = i + name.length; k < slice.length; k++) {
    const c = slice[k]!;
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && (c === "{" || (c === "=" && slice[k + 1] === ">"))) { start = k + (c === "{" ? 1 : 2); break; }
    else if (depth === 0 && c === ";") break;
  }
  if (start < 0) return null;
  return { text: slice.slice(start), position: (at) => code.positionOf(from + start + at) };
}

/** Where `name` first stands as a whole word (`(?<![\w$])name\b`), or -1. */
function firstWord(text: string, name: string): number {
  // A name ending in `$` has no `\b` after it, so the pattern stays the reference.
  if (name === "" || name.includes("$") || /[^\w]/.test(name)) return text.search(new RegExp(String.raw`(?<![\w$])${escapeRegex(name)}\b`));
  for (let at = text.indexOf(name); at >= 0; at = text.indexOf(name, at + 1)) {
    if (at > 0 && /[\w$]/.test(text[at - 1]!)) continue;
    if (at + name.length < text.length && /\w/.test(text[at + name.length]!)) continue;
    return at;
  }
  return -1;
}

interface CodeView {
  text: string;
  offsetOf(line: number, column: number): number;
  positionOf(offset: number): { line: number; column: number };
}

/**
 * The file as code: comments and the literal parts of strings blanked (same length), the names an interpolation
 * reads (`'$squadSize'`, `'${club.badge}'`) kept.
 */
function codeView(lines: readonly string[]): CodeView {
  const source = lines.join("\n");
  // The blanked ranges arrive in order and are merged, so the copy is built from slices of the source.
  const parts: string[] = [];
  let last = 0;
  let pendingFrom = -1;
  let pendingTo = -1;
  const flush = (): void => {
    if (pendingFrom < 0) return;
    parts.push(source.slice(last, pendingFrom), source.slice(pendingFrom, pendingTo).replace(/[^\n]/g, " "));
    last = pendingTo;
    pendingFrom = -1;
  };
  const starts: number[] = [];
  let acc = 0;
  for (const l of lines) { starts.push(acc); acc += l.length + 1; }
  const n = source.length;
  const blank = (from: number, to: number): void => {
    const a = Math.max(from, last);
    const b = Math.min(to, n);
    if (b <= a) return;
    if (pendingFrom >= 0 && a <= pendingTo) pendingTo = Math.max(pendingTo, b);
    else {
      flush();
      pendingFrom = a;
      pendingTo = b;
    }
  };
  /** Scans a literal whose opening quote is at `open` and body starts at `from`; returns the index after it. */
  const scanString = (open: number, from: number, quote: string, triple: boolean, raw: boolean): number => {
    blank(open, from);
    let i = from;
    while (i < n) {
      const c = source[i]!;
      if (c === "\\" && !raw) { blank(i, i + 2); i += 2; continue; }
      const close = triple ? quote.repeat(3) : quote;
      if (source.startsWith(close, i)) { blank(i, i + close.length); return i + close.length; }
      if (!triple && c === "\n") return i;
      if (!raw && c === "$" && source[i + 1] === "{") {
        let depth = 1;
        let k = i + 2;
        for (; k < n && depth > 0; k++) { if (source[k] === "{") depth++; else if (source[k] === "}") depth--; }
        blank(i, i + 2);
        blank(k - 1, k);
        i = k;
        continue;
      }
      if (!raw && c === "$" && /[A-Za-z_]/.test(source[i + 1] ?? "")) {
        blank(i, i + 1);
        i++;
        while (i < n && /[\w$]/.test(source[i]!)) i++;
        continue;
      }
      blank(i, i + 1);
      i++;
    }
    return i;
  };
  let i = 0;
  while (i < n) {
    const c = source[i]!;
    if (c === "/" && source[i + 1] === "/") { const e = source.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === "/" && source[i + 1] === "*") { const e = source.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      const raw = i > 0 && source[i - 1] === "r" && !/[\w$]/.test(source[i - 2] ?? " ");
      const triple = source.startsWith(c.repeat(3), i);
      i = scanString(i, i + (triple ? 3 : 1), c, triple, raw);
      continue;
    }
    i++;
  }
  flush();
  parts.push(source.slice(last));
  return {
    text: parts.join(""),
    offsetOf: (line, column) => (line - 1 < starts.length ? starts[line - 1]! + column : source.length),
    positionOf: (offset) => {
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
      return { line: lo + 1, column: offset - starts[lo]! };
    },
  };
}
