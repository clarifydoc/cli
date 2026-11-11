import type { CallInfo, FileAnalysis, FunctionInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";

/**
 * A function or Observable kept as a property of a descriptor a class declares as a literal, then called through an
 * element it hands around: `tasks = [{ name: "convert", api: this.server.convert() }]` … `runTask(task) { task.api.subscribe() }`,
 * `actions = [{ title: "rename", callback: (x) => this.clubs.rename(x) }]` … `act(item) { item.callback(1) }`.
 * The call through the element is a call of what the descriptors hold under that key — the project calls the value
 * makes (a `this.`-rooted call, written in the literal). One distinct value: an INFERRED call. Several distinct values
 * and no way to tell which element runs: each is reported, AMBIGUOUS, never one picked. Only literals in the class's
 * own fields, only an element that is a parameter or local of the calling method (never `this` or an import), only a
 * key at most one such field holds — a key two fields hold with different values is read the same way, as ambiguous.
 */
export function addDescriptorCalls(analysis: FileAnalysis, raw: string): void {
  if (!/=\s*\[\s*\{|=\s*\{/.test(raw)) return;
  const lines = lineStarts(raw);
  for (const cls of analysis.classes) {
    const values = new Map<string, Map<string, CallInfo>>(); // key → call name → a representative call
    const methods = cls.methods ?? [];
    for (const field of cls.properties ?? []) {
      const start = fieldInitializerStart(raw, field.name, cls.line, cls.endLine, lines);
      if (start < 0) continue;
      for (const object of objectLiterals(raw, start)) {
        for (const { key, text, offset } of entries(object.text, object.offset)) {
          for (const name of heldCalls(text)) {
            const held = values.get(key) ?? values.set(key, new Map()).get(key)!;
            if (!held.has(name)) held.set(name, { name, kind: "internal", target: null, line: lineNo(lines, offset), confidence: "INFERRED" });
          }
        }
      }
    }
    if (values.size === 0) continue;
    for (const fn of methods) {
      const locals = localNames(fn, raw, lines);
      for (const site of [...fn.calls]) {
        const parts = site.name.split(".");
        if (parts.length < 2 || parts.length > 3 || !locals.has(parts[0]!) || /^(?:this|super)$/.test(parts[0]!)) continue;
        if (parts.length === 3 && !/^(?:subscribe|pipe|toPromise)$/.test(parts[2]!)) continue;
        const held = values.get(parts[1]!);
        if (!held) continue;
        for (const value of held.values()) {
          if (fn.calls.some((x) => x.name === value.name)) continue;
          fn.calls.push({ ...value, line: site.line, confidence: held.size > 1 ? "AMBIGUOUS" : "INFERRED", ...(held.size > 1 ? { alternative: true as const } : {}) });
        }
      }
    }
  }
}

/** Where `field = …` / `field: T = …` starts its initializer, inside the class's lines. */
function fieldInitializerStart(raw: string, field: string, from: number, to: number, lines: number[]): number {
  const begin = lines[Math.max(0, from - 1)] ?? 0;
  const end = lines[Math.min(lines.length - 1, to)] ?? raw.length;
  const re = new RegExp(String.raw`(?<![\w$.])` + escapeRegex(field) + String.raw`\s*[!?]?\s*(?::[^=;\n]+)?=\s*(?!=)`, "g");
  re.lastIndex = begin;
  const m = re.exec(raw);
  return m && m.index < end ? m.index + m[0].length : -1;
}

/** The object literals of an initializer that is one, or an array of them (`[{…}, {…}]`), or `{…}` wrapped in `as const`. */
function objectLiterals(raw: string, start: number): Array<{ text: string; offset: number }> {
  let i = start;
  while (/\s/.test(raw[i] ?? "")) i++;
  const out: Array<{ text: string; offset: number }> = [];
  if (raw[i] === "{") {
    const end = balanced(raw, i);
    if (end > 0) out.push({ text: raw.slice(i + 1, end), offset: i + 1 });
  } else if (raw[i] === "[") {
    const end = balanced(raw, i);
    if (end < 0) return out;
    for (let j = i + 1; j < end; j++) {
      if (raw[j] === "{") {
        const close = balanced(raw, j);
        if (close < 0 || close > end) break;
        out.push({ text: raw.slice(j + 1, close), offset: j + 1 });
        j = close;
      } else if (raw[j] === "(" || raw[j] === "[") {
        const close = balanced(raw, j);
        if (close < 0) break;
        j = close;
      }
    }
  }
  return out;
}

/** `key: value` members at the top level of an object body. */
function entries(body: string, offset: number): Array<{ key: string; text: string; offset: number }> {
  const out: Array<{ key: string; text: string; offset: number }> = [];
  let depth = 0;
  let from = 0;
  const flush = (to: number) => {
    const part = body.slice(from, to);
    const m = /^\s*(?:["']([\w$-]+)["']|([A-Za-z_$][\w$]*))\s*:\s*/.exec(part);
    if (m) out.push({ key: (m[1] ?? m[2])!, text: part.slice(m[0].length), offset: offset + from + m[0].length });
    from = to + 1;
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < body.length && body[i] !== ch; i++) if (body[i] === "\\") i++;
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) flush(i);
  }
  flush(body.length);
  return out;
}

/**
 * The `this.`-rooted calls a descriptor value makes: an Observable-valued call (`this.server.convert()`,
 * chained operators included) or the calls inside a function written in place. A plain value holds none.
 */
function heldCalls(value: string): string[] {
  const text = value.trim();
  const isFunction = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>|^(?:async\s+)?function\b/.test(text);
  if (!isFunction && !/^this\.[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/.test(text)) return [];
  const names: string[] = [];
  for (const m of text.matchAll(/(?<![\w$.])this\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\(/g)) names.push(`this.${m[1]}`);
  // A direct value is its first call only: `this.server.convert().pipe(map(…))` is `this.server.convert`.
  return isFunction ? names : names.slice(0, 1);
}

/** Names a method binds itself: parameters, declarations, loop variables, arrow-function parameters. */
function localNames(fn: FunctionInfo, raw: string, lines: number[]): Set<string> {
  const names = new Set(fn.params.map((p) => p.name));
  const body = raw.slice(lines[Math.max(0, fn.line - 1)] ?? 0, lines[Math.min(lines.length - 1, fn.endLine)] ?? raw.length);
  for (const m of body.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/g)) names.add(m[1]!);
  for (const m of body.matchAll(/\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+(?:of|in)\b/g)) names.add(m[1]!);
  for (const m of body.matchAll(/(?:\(\s*([A-Za-z_$][\w$]*)\s*[,)]|(?<![\w$.])([A-Za-z_$][\w$]*)\s*=>)/g)) names.add((m[1] ?? m[2])!);
  return names;
}

/** The offset of the bracket closing the one at `open`, or -1. */
function balanced(raw: string, open: number): number {
  let depth = 0;
  for (let i = open; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < raw.length && raw[i] !== ch; i++) if (raw[i] === "\\") i++;
    } else if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

function lineNo(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
