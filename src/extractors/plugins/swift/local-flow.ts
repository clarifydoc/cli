import type { CallInfo, FunctionInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { elementType } from "./collection-types.js";

/**
 * What a Swift body states about a binding without declaring its type: the declared return type of a function
 * (`-> Engine`), a local bound to a call (`let e = car.engine()`), a loop or closure variable over a typed
 * collection, and a name a pattern narrows (`if let`, `guard let`, `as? Club`, `case let c as Club`). Facts only:
 * the linker types a `from` chain through declared return types; an element or narrowed type is stated here.
 */

type Local = NonNullable<FunctionInfo["localTypes"]>[number];

/**
 * One entry per name; a name declared again with a different type or key
 * (`let r = PgRepo()` in one branch, `let r = MemRepo()` in another) is
 * dropped — which declaration a call sees is a scoping question a line scan
 * cannot answer.
 */
export function uniqueLocals(entries: NonNullable<FunctionInfo["localTypes"]>): NonNullable<FunctionInfo["localTypes"]> {
  type Entry = NonNullable<FunctionInfo["localTypes"]>[number];
  const byName = new Map<string, Entry | null>();
  for (const e of entries) {
    const prev = byName.get(e.name);
    if (prev === undefined) byName.set(e.name, e);
    else if (prev && (prev.type !== e.type || prev.qualifier !== e.qualifier || prev.from !== e.from || prev.fromElement !== e.fromElement)) byName.set(e.name, null);
  }
  return [...byName.values()].filter((e): e is Entry => e !== null);
}

const codeOf = (line: string): string => {
  const code = blankStringLiterals(line);
  const comment = code.indexOf("//");
  return comment < 0 ? code : code.slice(0, comment);
};

/** Index just past the bracket closing the one at `open` (`(` or `<`), or -1. */
function closeOf(code: string, open: number): number {
  const [o, c] = code[open] === "<" ? ["<", ">"] : ["(", ")"];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "-" && code[i + 1] === ">") {
      i++;
      continue;
    }
    if (code[i] === o) depth++;
    else if (code[i] === c && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * The declared return type of the function whose name starts at `nameColumn` on `line`:
 * `func engine() -> Engine`, `func clubs() async throws -> [Club] {`. Null for no arrow, `Void`, `()`, or a
 * parameter list that wraps onto the next line.
 */
export function parseSwiftReturnType(line: string, nameColumn?: number): string | null {
  const head = codeOf(nameColumn !== undefined && nameColumn >= 0 ? line.slice(nameColumn) : line);
  let i = head.search(/[<(]/);
  if (i < 0) return null;
  if (head[i] === "<") {
    i = closeOf(head, i);
    if (i < 0) return null;
    while (head[i] === " ") i++;
  }
  if (head[i] !== "(" || /^[\w]+\s*:/.test(head)) return null;
  const close = closeOf(head, i);
  if (close < 0) return null;
  const m = /^\s*(?:async\s+)?(?:(?:re)?throws(?:\s*\([^)]*\))?\s*)?(?:async\s+)?->\s*([^{]+?)\s*(?:\bwhere\b.*|\{.*)?$/.exec(head.slice(close));
  if (!m) return null;
  const type = m[1]!.replace(/^(?:some|any)\s+/, "").trim();
  return !type || type === "Void" || type === "()" ? null : type;
}

/**
 * A local's initializer that is one call chain — `car.engine()`, `try await self.repo.find(id)`, `League.load()`
 * — as the `from` the linker types it by (`car.engine()`; `self.` and optional chaining dropped); null for
 * anything else (a literal, an operator, a closure, a construction, a bare function).
 */
export function callFrom(rhs: string, bare = false): { from: string; awaited?: boolean } | null {
  let text = codeOf(rhs).trim();
  const awaited = /\bawait\s/.test(text.match(/^(?:try[?!]?\s+)?(?:await\s+)?/)![0]);
  text = text.replace(/^(?:try[?!]?\s+)?(?:await\s+)?(?:try[?!]?\s+)?/, "").replace(/^self\s*\./, "");
  const m = new RegExp(String.raw`^([A-Za-z_]\w*(?:\s*[?!]?\s*\.\s*[A-Za-z_]\w*)${bare ? "*" : "+"})\s*\(`).exec(text);
  if (!m) return null;
  const open = m[0].length - 1;
  const close = closeOf(text, open);
  const tail = text.slice(close).trim();
  // A trailing `!`/`?` unwraps the result; anything else (an operator, a further member) is another expression.
  if (close < 0 || !/^[!?]?$/.test(tail)) return null;
  const path = m[1]!.replace(/\s+/g, "").replace(/[?!]\./g, ".");
  const parts = path.split(".");
  // A capitalized last name is a construction or a nested type, never a method.
  if (/^[A-Z]/.test(parts.at(-1)!)) return null;
  return { from: `${path}()`, ...(awaited ? { awaited: true } : {}) };
}

export { elementType } from "./collection-types.js";

/** The type an optional declares (`Club?`, `Optional<Club>`), or the type itself when it is plainly one name. */
function plainType(type: string | null | undefined): string | null {
  const m = /^\s*(?:Optional\s*<\s*([A-Z][\w.]*)\s*>|([A-Z][\w.]*))\s*[?!]?\s*$/.exec(type ?? "");
  return m?.[1] ?? m?.[2] ?? null;
}

/** Calls on a collection that hand each element to their closure; those that keep the collection's element type. */
const ELEMENT_CALLBACKS = "forEach|map|compactMap|filter|first|last|contains|allSatisfy|firstIndex|lastIndex|drop|prefix|min|max|sorted|sort|removeAll|reduce|flatMap";
const KEEPS_ELEMENTS: ReadonlySet<string> = new Set(["filter", "sorted", "reversed", "dropFirst", "dropLast", "prefix", "suffix", "shuffled", "lazy", "drop"]);

interface Known {
  /** Names whose declared type is stated: parameters and typed locals. */
  types: Map<string, string>;
}

/**
 * The locals a Swift body's bindings state: loop and closure variables over a typed collection, and names
 * narrowed by `if let x = y`, `guard let`, `as? T`, `case let c as T` and `case let .some(c) = y`.
 */
export function swiftFlowLocals(code: string, known: Known): Local[] {
  const out: Local[] = [];
  const typeOfExpr = (expr: string): string | null => {
    const e = expr.trim();
    const cast = /\bas[?!]\s*([A-Z][\w.]*)\s*$/.exec(e);
    if (cast) return cast[1]!;
    const bare = /^(?:self\s*\.\s*)?([a-z_]\w*)\s*[?!]?$/.exec(e);
    return bare ? plainType(known.types.get(bare[1]!)) : null;
  };
  // `if let a = x, let b = y`, `guard let a = x else`, `while let a = x`.
  for (const stmt of code.matchAll(/\b(?:if|guard|while)\b([^{]*)/g)) {
    const clause = stmt[1]!.replace(/\belse\s*$/, "");
    for (const m of clause.matchAll(/\b(?:let|var)\s+([a-z_]\w*)\s*=\s*((?:[^,(]|\([^)]*\))+)/g)) {
      const type = typeOfExpr(m[2]!);
      if (type) out.push({ name: m[1]!, type });
    }
    // `if case let .some(c) = maybeClub`, `if case .some(let c) = maybeClub`.
    for (const m of clause.matchAll(/\bcase\s+(?:let\s+)?\.some\s*\(\s*(?:let\s+)?([a-z_]\w*)\s*\)\s*=\s*([^,]+)/g)) {
      const type = typeOfExpr(m[2]!);
      if (type) out.push({ name: m[1]!, type });
    }
  }
  // `case let c as Club:`, `case .a(let c as Club)`: the pattern states the type.
  for (const m of code.matchAll(/\b(?:let|var)\s+([a-z_]\w*)\s+as\s+([A-Z][\w.]*)/g)) out.push({ name: m[1]!, type: m[2]! });
  // `for p in squad.list()`, `for p in self.repo.players()`: the element of the collection the call is declared to return.
  for (const f of code.matchAll(/\bfor\s+(?:case\s+)?(?:let\s+)?([a-z_]\w*)\s+in\s+([^{\n]+?)\s*(?:\{|$|\bwhere\b)/gm)) {
    const call = callFrom(f[2]!, true);
    if (call) out.push({ name: f[1]!, type: "", ...call, fromElement: true });
  }
  // `for c in clubs`, `for (i, c) in clubs.enumerated()`, `for c in clubs.filter { … }`.
  for (const [name, element] of elementsOf(known)) {
    const base = String.raw`(?<![\w$.])(?:self\s*\.\s*)?${name}\b`;
    const chain = String.raw`${base}(?:\s*[?!]?\.\s*(?:${[...KEEPS_ELEMENTS].join("|")}|reversed)\b(?:\s*\([^()]*\))?)*`;
    for (const f of code.matchAll(new RegExp(String.raw`\bfor\s+(?:case\s+)?(?:let\s+)?([a-z_]\w*)\s+in\s+${chain}\s*(?:\{|$|where\b)`, "g"))) out.push({ name: f[1]!, type: element });
    for (const f of code.matchAll(new RegExp(String.raw`\bfor\s+\(\s*[a-z_]\w*\s*,\s*([a-z_]\w*)\s*\)\s+in\s+${chain}\.enumerated\(\)`, "g"))) out.push({ name: f[1]!, type: element });
    // `clubs.forEach { c in … }`, `clubs.filter { $0.a }.map { $0.promote() }`.
    const callbacks = new RegExp(String.raw`${chain}(?:\s*[?!]?\.\s*(${ELEMENT_CALLBACKS})\b)\s*(?:\([^()]*\))?\s*\{\s*(?:\[[^\]]*\]\s*)?(?:\(?\s*([a-z_]\w*)\s*(?:,\s*([a-z_]\w*))?\s*(?::\s*[\w.?]+)?\s*\)?\s+in\b)?`, "g");
    for (const c of code.matchAll(callbacks)) {
      const method = c[1]!;
      // `reduce`/`sorted(by:)` hand two arguments; `reduce` leads with its accumulator.
      if (method === "reduce") {
        if (c[3]) out.push({ name: c[3], type: element });
        else if (!c[2]) out.push({ name: "$1", type: element });
        continue;
      }
      if (c[2]) {
        out.push({ name: c[2], type: element });
        if (c[3] && (method === "sorted" || method === "sort")) out.push({ name: c[3], type: element });
      } else {
        out.push({ name: "$0", type: element });
        if (method === "sorted" || method === "sort") out.push({ name: "$1", type: element });
      }
    }
  }
  return out;
}

function elementsOf(known: Known): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, type] of known.types) {
    const element = elementType(type);
    if (element) out.set(name, element);
  }
  return out;
}

/** A body's own declarations of a stated type, for `swiftFlowLocals`: `let clubs: [Club] = …`. */
export function declaredTypes(code: string, params: ReadonlyArray<{ name: string; type: string | null }> | undefined): Known {
  const types = new Map<string, string>();
  for (const p of params ?? []) if (p.type) types.set(p.name, p.type);
  for (const m of code.matchAll(/\b(?:let|var)\s+([a-z_]\w*)\s*:\s*([^=\n{]+?)\s*(?:=|$|\n)/gm)) types.set(m[1]!, m[2]!.trim());
  return { types };
}

/**
 * A closure's `$0` is typed only when a typed collection hands it its element; any other `$0.m(` goes back to
 * the bare method, as the call scan reads a receiver no name spells.
 */
export function settleAnonymousReceivers(calls: CallInfo[] | undefined, locals: readonly Local[]): void {
  if (!calls) return;
  const typed = new Set(locals.filter((l) => l.name.startsWith("$")).map((l) => l.name));
  for (const call of calls) {
    const m = /^(\$\d+)\.(.+)$/.exec(call.name);
    if (m && !typed.has(m[1]!)) call.name = m[2]!;
  }
}

/**
 * The loops, narrowings and closures of a method over the typed members of its own class (`for p in self.players`,
 * `if let c = captain`): `swiftFlowLocals` with the class's properties as the declared names — those the method
 * does not declare again — merged into the method's own locals.
 */
export function addMemberFlowLocals(lines: readonly string[], properties: ReadonlyArray<{ name: string; type: string | null }>, method: FunctionInfo): void {
  if (method.endLine < method.line || !properties.some((p) => p.type && elementOrPlain(p.type))) return;
  const code = lines.slice(method.line - 1, method.endLine).map(codeOf).join("\n");
  const declared = new Set<string>(method.params.map((p) => p.name));
  for (const m of code.matchAll(/\b(?:let|var)\s+([a-z_]\w*)/g)) declared.add(m[1]!);
  for (const m of code.matchAll(/\bfor\s+(?:case\s+)?(?:let\s+)?([a-z_]\w*)\b/g)) declared.add(m[1]!);
  const types = new Map<string, string>();
  for (const p of properties) if (p.type && !declared.has(p.name)) types.set(p.name, p.type);
  if (types.size === 0) return;
  const found = swiftFlowLocals(code, { types }).filter((l) => !(method.localTypes ?? []).some((e) => e.name === l.name && e.type === l.type && e.from === l.from));
  if (found.length === 0) return;
  method.localTypes = uniqueLocals([...(method.localTypes ?? []), ...found]);
}

const elementOrPlain = (type: string): boolean => elementType(type) !== null || plainType(type) !== null;
