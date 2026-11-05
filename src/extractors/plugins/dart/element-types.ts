import type { CallInfo, FunctionInfo, PropertyInfo } from "../../../types/analysis.js";
import { escapeRegex } from "../shared/path-utils.js";
import { closeOf, codeOf, elementParams, elementType, mapValueType, uniqueLocals } from "./di.js";

/**
 * What a Dart body states about a binding without declaring it: the element a typed collection hands out
 * (a `List<Club>` FIELD, a local built from `<Club>[]` or `[Club()]`, a map's values), the element read by index,
 * `.first` or `.last`, and the type an `is` test narrows a name to. Everything is read from types as written.
 */
export interface DartCollections {
  /** Name → element class of a list/set/iterable. */
  lists: Map<string, string>;
  /** Name → value class of a map. */
  maps: Map<string, string>;
}

/** The collection-typed fields of a class, by name. */
export function fieldCollections(properties: readonly PropertyInfo[]): DartCollections | null {
  const lists = new Map<string, string>();
  const maps = new Map<string, string>();
  for (const p of properties) {
    const list = elementType(p.type);
    const map = mapValueType(p.type);
    if (list) lists.set(p.name, list);
    else if (map) maps.set(p.name, map);
  }
  return lists.size > 0 || maps.size > 0 ? { lists, maps } : null;
}

const TYPED_COLLECTION = /^\s*(?:final\s+|late\s+|const\s+|var\s+)*((?:List|Iterable|Set|Map|Queue)\s*<[^;=]*?>)\??\s+([a-z_$]\w*)\s*(?:=|;)/;
const LITERAL_COLLECTION = /^\s*(?:final|var|late)\s+([a-z_$]\w*)\s*=\s*(?:const\s+)?(?:<\s*([A-Z]\w*)\s*>\s*[\[{]|<\s*[\w<>?]+\s*,\s*([A-Z]\w*)\s*>\s*\{|(?:List|Set)\s*<\s*([A-Z]\w*)\s*>\s*\.\s*(?:empty|of|from|generate|filled)\s*\(|\[\s*([A-Z]\w*)\s*[.(])/;

/**
 * Add what the body's collections, `is` tests and element reads state to `fn`: loop variables and closure parameters
 * over a field or a literal-built collection and over a map's values, `final c = clubs[0]` / `byName['a']!` /
 * `clubs.first`, calls on an indexed element (`clubs[0].promote()` → `clubs[].promote`), and a call on a name inside the
 * span an `is Club` test promotes it in.
 */
export function addDartElementTypes(fn: FunctionInfo, lines: readonly string[], fields: DartCollections | null): void {
  if (fn.endLine < fn.line) return;
  const code = lines.slice(fn.line - 1, fn.endLine).map(codeOf);
  const body = code.join("\n");
  const hasIs = /\bis\b/.test(body);
  const mayCollect = fields !== null || /<|\[|\bMap\b|\bList\b/.test(body);
  if (!hasIs && !mayCollect) return;

  const lists = new Map<string, string>();
  const maps = new Map<string, string>();
  const declared = new Set<string>(fn.params.map((p) => p.name.replace(/^this\./, "")));
  for (const p of fn.params) {
    const name = p.name.replace(/^this\./, "");
    const l = elementType(p.type);
    const m = mapValueType(p.type);
    if (l) lists.set(name, l);
    else if (m) maps.set(name, m);
  }
  const bound = new Set<string>();
  for (const line of code) {
    const typed = TYPED_COLLECTION.exec(line);
    if (typed) {
      const l = elementType(typed[1]);
      const m = mapValueType(typed[1]);
      bound.add(typed[2]!);
      if (l) lists.set(typed[2]!, l);
      else if (m) maps.set(typed[2]!, m);
      continue;
    }
    const lit = LITERAL_COLLECTION.exec(line);
    if (lit) {
      bound.add(lit[1]!);
      if (lit[3]) maps.set(lit[1]!, lit[3]);
      else if (lit[2] || lit[4] || lit[5]) lists.set(lit[1]!, (lit[2] ?? lit[4] ?? lit[5])!);
      continue;
    }
    const decl = /^\s*(?:(?:final|late|const|var)\s+)*(?:[A-Za-z_$][\w$<>?,. ]*?\s+)?([a-z_$]\w*)\s*(?:=|;)/.exec(line);
    if (decl) bound.add(decl[1]!);
  }
  // A field is the collection unless the body (or a parameter) declares a name of its own.
  if (fields) {
    for (const [n, e] of fields.lists) if (!declared.has(n) && !bound.has(n) && !lists.has(n)) lists.set(n, e);
    for (const [n, e] of fields.maps) if (!declared.has(n) && !bound.has(n) && !maps.has(n)) maps.set(n, e);
  }

  const extra: NonNullable<FunctionInfo["localTypes"]> = [];
  if (lists.size > 0 || maps.size > 0) {
    extra.push(...elementParams(body, lists, maps));
    for (const [name, element] of [...lists, ...maps]) {
      const n = escapeRegex(name);
      // `final c = clubs[0];` `var c = byName['a']!;` `final c = clubs.first;`
      for (const m of body.matchAll(new RegExp(String.raw`\b(?:final|var)\s+([a-z_$]\w*)\s*=\s*(?:this\.)?${n}\s*(?:\[[^\]]*\]|\.\s*(?:first|last|single)\b|\.\s*(?:firstWhere|lastWhere|singleWhere|elementAt)\s*\([^;]*\))\s*!?\s*;`, "g"))) {
        extra.push({ name: m[1]!, type: element });
      }
    }
    addAccessCalls(fn, code, lists, maps);
  }
  if (hasIs) addNarrowedCalls(fn, code);

  if (extra.length > 0) {
    const typedNames = new Set(extra.map((e) => e.name));
    const keep = (fn.localTypes ?? []).filter((l) => l.type || !typedNames.has(l.name));
    fn.localTypes = uniqueLocals([...keep, ...extra]);
  }
}

/** `clubs.first.promote()` typed, and `clubs[0].promote()` / `byName['a']?.promote()` added as `clubs[].promote`. */
function addAccessCalls(fn: FunctionInfo, code: readonly string[], lists: ReadonlyMap<string, string>, maps: ReadonlyMap<string, string>): void {
  const element = (name: string): string | undefined => lists.get(name) ?? maps.get(name);
  for (const call of fn.calls as CallInfo[]) {
    if (call.receiverType) continue;
    const parts = call.name.split(".");
    if (parts.length === 3 && /^(?:first|last|single)$/.test(parts[1]!) && lists.has(parts[0]!)) call.receiverType = lists.get(parts[0]!)!;
  }
  const have = new Set(fn.calls.map((c) => `${c.line}:${c.name}`));
  code.forEach((line, k) => {
    if (!line.includes("]")) return;
    const ln = fn.line + k;
    for (const m of line.matchAll(/(?<![\w$.])(?:this\s*\.\s*)?([a-z_$]\w*)\s*\[[^\]]*\]\s*[?!]?\s*\??\.\s*([A-Za-z_$]\w*)\s*\(/g)) {
      const type = element(m[1]!);
      if (!type) continue;
      const name = `${m[1]}[].${m[2]}`;
      if (have.has(`${ln}:${name}`)) continue;
      have.add(`${ln}:${name}`);
      fn.calls.push({ name, kind: "internal", target: null, line: ln, column: m.index!, receiverType: type });
    }
  });
}

/**
 * `if (x is Club) x.promote();`, `if (x is Club) { … }`, `x is Club && x.ok`, `x is Club ? x.promote() : …` and the
 * guard `if (x is! Club) return; x.promote();`: a call on `x` inside such a span states `Club` as its `receiverType`.
 * A name tested against two types is typed per span; anything outside a span stays untyped.
 */
function addNarrowedCalls(fn: FunctionInfo, code: readonly string[]): void {
  const spans: Array<{ name: string; type: string; from: number; to: number }> = [];
  for (let k = 0; k < code.length; k++) {
    const line = code[k]!;
    if (!/\bis\b/.test(line)) continue;
    const ln = fn.line + k;
    for (const m of line.matchAll(/\b([a-z_$]\w*)\s+is(!?)\s+([A-Z]\w*)\b(?:<[^()]*?>)?\??/g)) {
      const [, name, negated, type] = m;
      const head = line.slice(0, m.index!);
      const ifAt = /\bif\s*\(/.exec(line);
      if (!negated) {
        // `x is T && x.ok` / `x is T ? x.m() : …` — the rest of the line.
        let to = ln;
        if (ifAt && ifAt.index < m.index!) {
          const open = line.indexOf("(", ifAt.index);
          const close = closeOf(line, open);
          const rest = close > 0 ? line.slice(close).trim() : "";
          if (close > 0 && rest.startsWith("{")) to = blockEnd(code, k) + fn.line;
          else if (close > 0 && rest === "") to = ln + 1;
        }
        spans.push({ name: name!, type: type!, from: ln, to });
      } else if (ifAt && head.includes("(")) {
        const open = line.indexOf("(", ifAt.index);
        const close = closeOf(line, open);
        const rest = close > 0 ? line.slice(close).trim() : "";
        let exits = /^(?:return|throw|continue|break)\b/.test(rest);
        let blockTo = ln;
        if (rest.startsWith("{")) {
          blockTo = blockEnd(code, k) + fn.line;
          exits = code.slice(k, blockTo - fn.line + 1).some((l) => /\b(?:return|throw|continue|break)\b/.test(l));
        } else if (rest === "") exits = /^\s*(?:return|throw|continue|break)\b/.test(code[k + 1] ?? "");
        if (exits) spans.push({ name: name!, type: type!, from: Math.max(ln, blockTo) + 1, to: fn.line + enclosingEnd(code, k) });
      }
    }
  }
  if (spans.length === 0) return;
  for (const call of fn.calls as CallInfo[]) {
    if (call.receiverType) continue;
    const parts = call.name.split(".");
    if (parts.length !== 2) continue;
    const hits = spans.filter((s) => s.name === parts[0] && call.line >= s.from && call.line <= s.to);
    if (hits.length === 0) continue;
    const types = new Set(hits.map((h) => h.type));
    if (types.size === 1) call.receiverType = hits[0]!.type;
  }
}

/** Index (in `code`) of the line that closes the block opened on or after line `k`. */
function blockEnd(code: readonly string[], k: number): number {
  let depth = 0;
  let opened = false;
  for (let i = k; i < code.length; i++) {
    for (const c of code[i]!) {
      if (c === "{") { depth++; opened = true; }
      else if (c === "}") depth--;
    }
    if (opened && depth <= 0) return i;
  }
  return code.length - 1;
}

/** Index of the line that closes the block line `k` stands in (the function's end when `k` is at its top). */
function enclosingEnd(code: readonly string[], k: number): number {
  let depth = 0;
  for (let i = k; i < code.length; i++) {
    for (const c of code[i]!) {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth < 0) return i;
      }
    }
  }
  return code.length - 1;
}
