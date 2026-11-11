import type { FunctionInfo } from "../../../types/analysis.js";

/**
 * A struct built by a literal — Go `Club{Name: "x"}` / `&models.Club{}`, Rust `Club { name }` /
 * `league::Club { name }` — constructs its type as `new Club(…)` does elsewhere, though no call is written.
 * `withStructLiteralCalls` adds that construction to the enclosing function as a call naming the type
 * (bare, or through the path as written): marked `construction: "literal"`, so the linker joins it to the
 * struct itself and never retargets it to a function called `New`/`new` (a literal runs none).
 *
 * Only an expression position counts (after `=`, `(`, `,`, `:`, `{`, `&`, `return`, …): a block opener —
 * `if x {`, `impl Club {`, `-> Club {`, `for c in clubs {` — is not a literal. A lowercase name is read only where
 * the language lets a type be lowercase (Go), a type nothing declares links nothing.
 */
export interface StructLiteralRules {
  /** Segment separator of a qualified type: Go `.`, Rust `::`. */
  separator: "." | "::";
  /** The last segment must be capitalized (Rust types always are). */
  capitalized: boolean;
  /** Words that end the text before a literal in expression position (`return`, `case`, `=>`…). */
  leadWords: readonly string[];
  /** Names that are never a struct (`struct`, `interface`, `Self`…). */
  notTypes: ReadonlySet<string>;
}

/** Strings and trailing comments blanked, so a brace in either is not read. Lengths are kept. */
function blank(line: string, lineComment: string): string {
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (line.startsWith(lineComment, i)) return out + " ".repeat(line.length - i);
    // A rune / char literal (`'"'`, `'\\n'`) is no string opener; a Rust lifetime (`'a`) has no closing quote there.
    if (ch === "'") {
      const rune = /^'(?:\\.[^']*|[^'\\])'/.exec(line.slice(i));
      if (rune) {
        out += " ".repeat(rune[0].length);
        i += rune[0].length - 1;
        continue;
      }
    }
    if (ch === '"' || ch === "`") {
      const end = line.indexOf(ch, i + 1);
      const stop = end < 0 ? line.length - 1 : end;
      out += ch + " ".repeat(Math.max(0, stop - i - 1)) + (end < 0 ? "" : ch);
      i = stop;
      continue;
    }
    out += ch;
  }
  return out;
}

function inExpressionPosition(before: string, rules: StructLiteralRules): boolean {
  const text = before.trimEnd();
  if (!text) return true;
  const last = text[text.length - 1]!;
  if (last === "=") {
    // `==`, `!=`, `<=`, `>=` compare: a block opener follows, not a literal (Rust forbids a literal there).
    const prev = text[text.length - 2];
    return !(prev === "=" || prev === "!" || prev === "<" || prev === ">");
  }
  if ("(,:{&[".includes(last)) return true;
  if (text.endsWith("=>")) return rules.leadWords.includes("=>");
  return rules.leadWords.some((w) => /^\w+$/.test(w) && new RegExp(`(?:^|[^\\w.])${w}$`).test(text));
}

/** What follows the brace group opening at `col`: a match arm, an or-pattern or a destructuring assignment names a pattern. */
function isPattern(maskedLine: (n: number) => string, n: number, col: number, last: number): boolean {
  let depth = 0;
  for (let i = n; i < Math.min(last, n + 40); i++) {
    const text = maskedLine(i);
    for (let j = i === n ? col : 0; j < text.length; j++) {
      const ch = text[j];
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) return /^\s*(?:=>|\||\)*\s*=(?!=))/.test(text.slice(j + 1));
    }
  }
  return false;
}

export function withStructLiteralCalls(
  lines: string[],
  fns: FunctionInfo[],
  rules: StructLiteralRules,
  lineComment: string,
): FunctionInfo[] {
  const sep = rules.separator === "." ? "\\." : "::";
  const segment = "[A-Za-z_]\\w*";
  const tail = rules.capitalized ? "[A-Z]\\w*" : segment;
  const literal = new RegExp(`((?:${segment}${sep})*${tail})\\s*\\{`, "g");
  const masked = new Map<number, string>();
  const maskedLine = (n: number): string => {
    let m = masked.get(n);
    if (m === undefined) {
      m = blank(lines[n] ?? "", lineComment);
      masked.set(n, m);
    }
    return m;
  };
  for (const fn of fns) {
    if (fn.line === undefined) continue;
    const last = Math.min(lines.length, fn.endLine ?? fn.line);
    // The body starts after the first brace: a signature, its `where` clause or result type name types, not literals.
    let started = false;
    for (let n = fn.line - 1; n < last; n++) {
      const text = maskedLine(n);
      let from = 0;
      if (!started) {
        const open = text.indexOf("{");
        if (open < 0) continue;
        started = true;
        from = open + 1;
      }
      literal.lastIndex = from;
      for (let m = literal.exec(text); m; m = literal.exec(text)) {
        const name = m[1]!;
        const at = m.index;
        const leaf = name.split(rules.separator).pop()!;
        if (rules.notTypes.has(leaf) || rules.notTypes.has(name)) continue;
        // A member access (`a.b{`) or a call result is no type path: the name starts a path.
        const prev = text[at - 1];
        if (prev !== undefined && /[\w.]/.test(prev)) continue;
        if (text.slice(0, at).endsWith("::") || text.slice(0, at).endsWith(".")) continue;
        let before = text.slice(0, at);
        // `a && b {` is a condition, not an address-of literal.
        if (before.trimEnd().endsWith("&&")) continue;
        if (before.endsWith("&")) before = before.slice(0, -1);
        // `[]Club{…}` / `map[string]Club{…}` build a collection, not a `Club`.
        if (/\]\s*\*?$/.test(before)) continue;
        if (before.trimEnd().endsWith("*") && !/[=(,:]\s*\*$/.test(before.trimEnd())) continue;
        if (!inExpressionPosition(before, rules)) continue;
        if (isPattern(maskedLine, n, at + m[0].length - 1, last)) continue;
        // A `case Club{…}:` and `x := Club{…}` alike; one call per literal, never twice at one place.
        const column = at;
        if (fn.calls.some((c) => c.line === n + 1 && c.column === column && c.name === name)) continue;
        fn.calls.push({ name, kind: "internal", target: null, line: n + 1, column, construction: "literal" });
      }
    }
  }
  return fns;
}
