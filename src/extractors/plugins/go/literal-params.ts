import { blankStringLiterals } from "../shared/regex-base.js";
import { matchingClose, splitGoTopLevel, stripGoComment } from "./syntax.js";

/** What the function literals of a body bind as parameters. */
export interface GoLiteralParams {
  /** Every parameter name any literal binds, typed or not. */
  names: Set<string>;
  /** The parameters whose written type is one named type (`*Garage`, `repo.Store`), each name once with agreeing types. */
  typed: Array<{ name: string; type: string }>;
}

/** A type a member call can be resolved on: one (qualified) name, optionally behind a pointer. */
const NAMED_TYPE = /^\*?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/;
/** What may follow a literal's parameter list before its body: nothing, one result type or a parenthesized list. */
const BODY_START = /^\s*(?:\([^()]*\)|[\w.*[\]]+)?\s*\{/;

/**
 * The parameters of the function literals in a function body — `run := func(g *Garage) { g.Open() }`,
 * `func(s *Store) { s.Save() }(nil)`, `sort.Slice(x, func(i, j int) bool {…})` — the way a declared function's own
 * parameters are read, so a call on one is typed by it. A literal's calls belong to the function that holds it, hence
 * these go in that function's `localTypes`. A name two literals type differently, or one literal leaves untyped, is
 * left out (which one a call sees cannot be told from here), as is a variadic or unnamed parameter.
 */
export function goLiteralParams(body: readonly string[]): GoLiteralParams {
  const text = body.map((l) => blankStringLiterals(stripGoComment(l))).join("\n");
  const names = new Set<string>();
  const types = new Map<string, Set<string>>();
  const untyped = new Set<string>();
  // Where each name is bound: from a literal's `func(` to the end of its body.
  const spans = new Map<string, Array<[number, number]>>();
  for (const m of text.matchAll(/(?<![\w.])func\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingClose(text, open);
    if (close < 0 || !BODY_START.test(text.slice(close + 1, close + 200))) continue;
    const bodyOpen = text.indexOf("{", close);
    const bodyClose = matchingClose(text, bodyOpen);
    const span: [number, number] = [open, bodyClose < 0 ? text.length : bodyClose];
    const tokens = splitGoTopLevel(text.slice(open + 1, close));
    if (!tokens.some((t) => /^[A-Za-z_]\w*\s+\S/.test(t))) {
      // Unnamed parameters (`func(*Garage)`) or none: nothing is bound.
      continue;
    }
    // `a, b *Garage`: a bare name takes the type of the next token that writes one.
    let pending: string | null = null;
    for (let i = tokens.length - 1; i >= 0; i--) {
      const token = tokens[i]!;
      const named = /^([A-Za-z_]\w*)\s+(\S[\s\S]*)$/.exec(token);
      let name: string;
      if (named) {
        name = named[1]!;
        pending = named[2]!.replace(/\s+/g, "");
      } else if (/^[A-Za-z_]\w*$/.test(token)) name = token;
      else continue;
      names.add(name);
      if (name === "_") continue;
      (spans.get(name) ?? spans.set(name, []).get(name)!).push(span);
      if (pending && NAMED_TYPE.test(pending)) (types.get(name) ?? types.set(name, new Set()).get(name)!).add(pending);
      else untyped.add(name);
    }
  }
  // A name the function also uses outside the literals binding it may be something else there (a package value, an
  // outer local): it is no literal's alone, so nothing is said about it.
  for (const [name, where] of spans) {
    for (const use of text.matchAll(new RegExp(`(?<![\\w.])${name}(?!\\w)`, "g"))) {
      if (where.some(([from, to]) => use.index! >= from && use.index! <= to)) continue;
      names.delete(name);
      types.delete(name);
      break;
    }
  }
  const typed: GoLiteralParams["typed"] = [];
  for (const [name, set] of types) {
    if (untyped.has(name) || new Set([...set].map((t) => t.replace(/^\*/, ""))).size !== 1) continue;
    typed.push({ name, type: [...set][0]! });
  }
  return { names, typed };
}
