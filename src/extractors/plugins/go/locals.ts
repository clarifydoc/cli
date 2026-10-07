import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";
import { blankStringLiterals } from "../shared/regex-base.js";
import { GO_TYPE_KEYWORDS, matchingClose, stripGoComment } from "./syntax.js";

type LocalTypes = NonNullable<FunctionInfo["localTypes"]>;

/**
 * Result types of the constructors declared in the same file — `NewPgRepo` →
 * [`*PgRepo`], `NewRepo` → [`*PgRepo`, `error`]. A local initialised from one
 * (`r := NewPgRepo()`, `r, err := NewRepo()`) takes the result at its
 * position. A constructor declared in another file is not visible per file,
 * and its local stays untyped.
 */
export type GoConstructors = ReadonlyMap<string, readonly string[]>;

/** A short variable declaration at the start of a statement: `a, b := rhs`. */
const SHORT_DECL_RE = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:=\s*(.*)$/;
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
): LocalTypes {
  const seen = new Map<string, Set<string>>();
  const unknown = new Set<string>();
  const record = (name: string, type: string | null): void => {
    if (name === "_") return;
    declared?.add(name);
    if (type === null) { unknown.add(name); return; }
    let set = seen.get(name);
    if (!set) seen.set(name, (set = new Set()));
    set.add(type.replace(/\s+/g, ""));
  };

  for (const raw of bodyLines) {
    if (!raw.includes("=") && !raw.includes("var")) continue;
    for (const statement of statements(blankStringLiterals(stripGoComment(raw)))) {
      // What is left to scan for declarations whose type is not read.
      let rest = statement;
      const short = SHORT_DECL_RE.exec(statement);
      if (short && !/^\s*(?:if|for|switch|select|go|defer|return|case)\b/.test(statement)) {
        const names = splitNames(short[1]!);
        names.forEach((n, i) => record(n, initializerType(short[2]!, i, names.length, constructors)));
        rest = short[2]!;
      } else {
        const v = VAR_DECL_RE.exec(statement);
        if (v) {
          const names = splitNames(v[1]!);
          const tail = v[2]!.trim();
          if (tail.startsWith("=")) {
            names.forEach((n, i) => record(n, initializerType(tail.slice(1), i, names.length, constructors)));
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
    if (unknown.has(name) || types.size !== 1) continue;
    const type = [...types][0]!;
    const param = params.find((p) => p.name === name);
    if (param && (param.type ?? "").replace(/^\*/, "") !== type.replace(/^[*&]/, "")) continue;
    out.push({ name, type });
  }
  return out;
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
function initializerType(rhs: string, index: number, count: number, constructors?: GoConstructors): string | null {
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
