import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { GO_TYPE_KEYWORDS, matchingClose, stripGoComment } from "./syntax.js";
import { collectionBuilt, goCollection, goElementInit, goExprType, type GoTypeEnv } from "./element-types.js";

type LocalTypes = NonNullable<FunctionInfo["localTypes"]>;

/**
 * Result types of the constructors declared in the same file — `NewPgRepo` →
 * [`*PgRepo`], `NewRepo` → [`*PgRepo`, `error`]. A local initialised from one
 * (`r := NewPgRepo()`, `r, err := NewRepo()`) takes the result at its
 * position. A constructor declared in another file is not visible per file,
 * and its local stays untyped.
 */
export type GoConstructors = ReadonlyMap<string, readonly string[]>;

/** What a body's reading is given beyond the parameters, and hands back for the passes that follow it. */
export interface GoBodyReading {
  env: GoTypeEnv;
  /** The receiver's name and type, when the function is a method: a field chain starts from it. */
  receiver?: { name: string; type: string } | null;
  /** Parameter types as written (`[]Club`, `map[string]*Club`), which the parsed parameters bare. */
  paramTypes?: ReadonlyMap<string, string>;
  /** Set by the reading: the type of a bare name as the body states it. */
  typeOfName?: (name: string) => string | null;
}

/** A short variable declaration at the start of a statement: `a, b := rhs`. */
const SHORT_DECL_RE = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=\s*(.*)$/;
/** `for k, v := range expr {` / `for v := range expr {`. */
const RANGE_RE = /^\s*for\s+([A-Za-z_]\w*)\s*(?:,\s*([A-Za-z_]\w*)\s*)?:=\s*range\s+(.+?)\s*\{?\s*$/;
/** The init statement of an `if` (`if c, ok := m[k]` before its `;`). */
const IF_INIT_RE = /^\s*if\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=\s*(.+)$/;
/** `var a, b T`, `var a T = rhs`, `var a = rhs`. */
const VAR_DECL_RE = /^\s*var\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(.*)$/;
/** Any other `:=` on the line — `if v, ok := …;`, `for _, u := range …`, `switch x := v.(type)`. */
const ANY_SHORT_DECL_RE = /([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=/g;

/**
 * Locals whose type the body states, per Go's declaration forms:
 *
 *   r := &PgRepo{…}   r := PgRepo{…}   r := new(PgRepo)   → *PgRepo / PgRepo / *PgRepo
 *   var r UserRepo    var r UserRepo = …                  → UserRepo (the declared type wins)
 *   var r = &PgRepo{…}                                    → *PgRepo
 *   r := NewPgRepo()  r, err := NewRepo(cfg)              → the same-file constructor's result
 *   u, err := repo.Find(id)   r := store.NewRepo()        → `from` that call: core types it by
 *                                                          the callee's declared (first) result
 *   c := s.ordersClient                                   → `from` that field
 *
 * Types are kept as written (`*PgRepo`, `repo.UserRepo`); the linker bares
 * them. A name declared more than once with different or unknown types
 * (`if r := other(); …` shadowing it), or shadowing a parameter of another
 * type, is left out — which declaration a call sees cannot be told here.
 * `declared` collects every name the body declares, typed or not, so the
 * caller can tell when the receiver variable is shadowed.
 */
export function extractGoLocalTypes(
  bodyLines: string[],
  params: readonly ParamInfo[],
  constructors?: GoConstructors,
  declared?: Set<string>,
  reading?: GoBodyReading,
): LocalTypes {
  const env = reading?.env;
  const receiver = reading?.receiver;
  const seen = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  // Names bound to a value of a type this reading cannot state (everything `unknown` holds except a collection built
  // in place, which is typed as a collection and only left out of the emitted locals).
  const opaque = new Set<string>();
  const shapes = new Map<string, Set<string>>();
  const typeOfName = (name: string): string | null => {
    if (opaque.has(name)) return null;
    const stated = new Set([...(seen.get(name) ?? []), ...(shapes.get(name) ?? [])]);
    if (new Set([...stated].map(bareType)).size > 1) return null;
    if (stated.size >= 1) return [...stated][0]!;
    if (unknown.has(name)) return null;
    const param = reading?.paramTypes?.get(name) ?? params.find((p) => p.name === name)?.type;
    if (param) return param;
    if (receiver && name === receiver.name) return receiver.type;
    return env?.packageVars.get(name) ?? null;
  };
  if (reading) reading.typeOfName = typeOfName;
  const typed = env ?? { fields: new Map(), packageVars: new Map(), results: new Map() };
  const fromCalls = new Map<string, Set<string>>();
  const record = (name: string, type: string | null): void => {
    if (name === "_") return;
    declared?.add(name);
    if (type === null) { unknown.add(name); opaque.add(name); return; }
    let set = seen.get(name);
    if (!set) seen.set(name, (set = new Set()));
    set.add(type.replace(/\s+/g, ""));
  };
  /** A stated type, else — for the first variable — the one call it is initialised from. */
  const recordInit = (name: string, rhs: string, index: number, count: number): void => {
    let type = initializerType(rhs, index, count, constructors);
    if (type === null && index === 0 && name !== "_") {
      // A collection built in place: typed as one for the loops over it, never emitted as a local's type.
      const built = collectionBuilt(rhs);
      if (built) {
        declared?.add(name);
        unknown.add(name);
        let set = shapes.get(name);
        if (!set) shapes.set(name, (set = new Set()));
        set.add(built.replace(/\s+/g, ""));
        return;
      }
      // The element of a collection, a channel's payload, a type assertion: the type the right side states.
      type = goElementInit(rhs, typed, typeOfName);
    }
    const call = type === null && index === 0 ? singleCall(rhs) ?? fieldAlias(rhs) : null;
    if (call === null || name === "_") { record(name, type); return; }
    declared?.add(name);
    let set = fromCalls.get(name);
    if (!set) fromCalls.set(name, (set = new Set()));
    set.add(call);
  };

  for (const raw of bodyLines) {
    if (!raw.includes("=") && !raw.includes("var")) continue;
    for (const statement of statements(blankStringLiterals(stripGoComment(raw)))) {
      // What is left to scan for declarations whose type is not read.
      let rest = statement;
      // `for _, c := range clubs {` — the variable is the collection's element.
      const range = RANGE_RE.exec(statement);
      if (range) {
        const coll = goCollection(goExprType(range[3]!, typed, typeOfName));
        const [first, second] = [range[1]!, range[2]];
        if (second) {
          record(first, null);
          record(second, coll && coll.kind !== "chan" ? coll.value : null);
        } else record(first, coll?.kind === "chan" ? coll.value : null);
        continue;
      }
      // `if c, ok := m[k]; ok {` — an element or an assertion in an if's init statement.
      const init = IF_INIT_RE.exec(statement);
      if (init) {
        const names = splitNames(init[1]!);
        const elem = goElementInit(init[2]!, typed, typeOfName);
        if (elem) {
          names.forEach((n, i) => record(n, i === 0 ? elem : null));
          continue;
        }
      }
      const short = SHORT_DECL_RE.exec(statement);
      if (short && !/^\s*(?:if|for|switch|select|go|defer|return|case)\b/.test(statement)) {
        const names = splitNames(short[1]!);
        names.forEach((n, i) => recordInit(n, short[2]!, i, names.length));
        rest = short[2]!;
      } else {
        const v = VAR_DECL_RE.exec(statement);
        if (v) {
          const names = splitNames(v[1]!);
          const tail = v[2]!.trim();
          if (tail.startsWith("=")) {
            names.forEach((n, i) => recordInit(n, tail.slice(1), i, names.length));
          } else {
            const type = tail.split("=")[0]!.trim();
            for (const n of names) record(n, type && !type.startsWith("(") ? type : null);
          }
          continue;
        }
      }
      // Declarations inside `if`/`for`/`switch` headers, or in a func literal:
      // their types are not read, but they shadow.
      ANY_SHORT_DECL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ANY_SHORT_DECL_RE.exec(rest)) !== null) {
        for (const n of splitNames(m[1]!)) record(n, null);
      }
    }
  }

  const out: LocalTypes = [];
  for (const [name, types] of seen) {
    if (unknown.has(name) || new Set([...types].map(bareType)).size !== 1 || fromCalls.has(name)) continue;
    const type = [...types][0]!;
    const param = params.find((p) => p.name === name);
    if (param && (param.type ?? "").replace(/^\*/, "") !== type.replace(/^[*&]/, "")) continue;
    out.push({ name, type });
  }
  for (const [name, calls] of fromCalls) {
    if (unknown.has(name) || seen.has(name) || params.some((p) => p.name === name)) continue;
    for (const from of calls) out.push({ name, type: "", from });
  }
  return out;
}

/** A type without its pointer: `*Club` and `Club` are one for a member call. */
const bareType = (type: string): string => type.replace(/^[*&]/, "");

/** `s.ordersClient` — a local standing for a field of a value, which a pass may type through the field. */
function fieldAlias(rhs: string): string | null {
  const m = /^\s*([a-z_]\w*\.[A-Za-z_]\w*)\s*;?\s*$/.exec(rhs);
  return m ? m[1]! : null;
}

/** `repo.Find(id)` / `store.NewRepo()` — the whole expression is ONE call: its chain as a call names it, `repo.Find()`. */
function singleCall(rhs: string): string | null {
  // A dereferenced receiver calls the same method: `(*c).Response()` → `c.Response()`.
  const text = rhs.trim().replace(/;\s*$/, "").replace(/^\(\s*\*\s*([A-Za-z_]\w*)\s*\)\./, "$1.");
  const m = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\s*\(/.exec(text);
  if (!m || GO_TYPE_KEYWORDS.has(m[1]!) || /^(?:make|new|len|cap|append|string|int|float64|byte|rune)$/.test(m[1]!)) return null;
  return matchingClose(text, m[0].length - 1) === text.length - 1 ? `${m[1]}()` : null;
}

/**
 * A line's statements: split at `;` outside brackets, and cut at a `}` that
 * closes a block the line did not open (a one-line body's end).
 */
function statements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) { out.push(line.slice(start, i)); start = i + 1; continue; }
      depth--;
    } else if (c === ";" && depth === 0) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.filter((s) => s.trim());
}

function splitNames(text: string): string[] {
  return text.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * The type the expression `rhs` gives the `index`-th of `count` variables it
 * initialises, or null when the expression does not state it.
 */
export function initializerType(rhs: string, index: number, count: number, constructors?: GoConstructors): string | null {
  const text = rhs.trim().replace(/;\s*$/, "");
  if (count === 1) {
    // `&T{…}` / `T{…}` / `pkg.T{…}` — a composite literal of a named type.
    const lit = /^(&?)\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\{/.exec(text);
    if (lit && !GO_TYPE_KEYWORDS.has(lit[2]!.split(".").pop()!)) return `${lit[1] ? "*" : ""}${lit[2]}`;
    const made = /^new\(\s*([A-Za-z_][\w.]*)\s*\)$/.exec(text);
    if (made && !GO_TYPE_KEYWORDS.has(made[1]!)) return `*${made[1]}`;
  }
  // `NewT(args)` — the whole expression is one call of a same-file constructor.
  const call = /^([A-Za-z_]\w*)\s*\(/.exec(text);
  if (call && constructors?.has(call[1]!)) {
    const close = matchingClose(text, call[0].length - 1);
    if (close === text.length - 1) {
      const results = constructors.get(call[1]!)!;
      if (results.length === count) return results[index] ?? null;
    }
  }
  return null;
}

/**
 * The package-level variables of a file whose type it states or its initializer gives: `var squad []Club`,
 * `var first = &Club{}`, `var registry = map[string]*Club{}`, `var home = NewClub()` (a same-file constructor), also
 * inside a `var ( … )` block. Name → type as written, with the line. A name declared twice is left out.
 */
export function goPackageVars(lines: readonly string[], constructors?: GoConstructors): Array<{ name: string; type: string; line: number }> {
  const out = new Map<string, { type: string; line: number } | null>();
  const add = (name: string, type: string | null, line: number): void => {
    if (name === "_") return;
    if (out.has(name) || type === null) { out.set(name, null); return; }
    out.set(name, { type: type.replace(/\s+/g, ""), line });
  };
  const read = (names: string[], tail: string, line: number): void => {
    const t = tail.trim();
    if (t.startsWith("=")) {
      const rhs = t.slice(1);
      names.forEach((n, i) => add(n, initializerType(rhs, i, names.length, constructors) ?? (names.length === 1 ? collectionBuilt(rhs) : null), line));
    } else {
      const type = t.split("=")[0]!.trim();
      for (const n of names) add(n, type && !type.startsWith("(") ? type : null, line);
    }
  };
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const code = blankStringLiterals(stripGoComment(lines[i] ?? ""));
    if (inBlock) {
      if (/^\s*\)/.test(code)) { inBlock = false; continue; }
      const m = /^\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(.*)$/.exec(code);
      if (m) read(splitNames(m[1]!), m[2]!, i + 1);
      continue;
    }
    if (/^var\s*\(\s*$/.test(code)) { inBlock = true; continue; }
    const m = /^var\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(.*)$/.exec(code);
    if (m) read(splitNames(m[1]!), m[2]!, i + 1);
  }
  return [...out].filter((e): e is [string, { type: string; line: number }] => e[1] !== null).map(([name, v]) => ({ name, ...v }));
}
