/*
 * The first of the C++ reading's two passes: what the parser's predicates (CPP14ParserBase.ts) ask of each token,
 * answered once — the bracket a bracket closes, the `>` closing a `<` that opens template arguments, the names the
 * file uses as types. A compiler learns the types and templates from the headers; an analyzer without the build's
 * include paths reads them off how the file uses them.
 */
import { CharStream, Token, type CommonTokenStream } from "antlr4ng";
import { CPP14Lexer } from "./CPP14Lexer.js";

/** The token types `texts` lex to: a rule with several spellings has no literal name to look up. */
export function typesOf(texts: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const text of texts) {
    const type = new CPP14Lexer(CharStream.fromString(text)).nextToken().type;
    if (type !== CPP14Lexer.Identifier) out.add(type);
  }
  return out;
}

/** Keywords that are a type by themselves. */
export const TYPE_KEYWORDS = typesOf([
  "void", "char", "char16_t", "char32_t", "wchar_t", "bool", "short", "int", "long", "float", "double", "signed",
  "unsigned", "auto", "decltype",
]);

/** Keywords a declaration may start with besides a type: storage classes, qualifiers, function specifiers. */
export const SPECIFIER_KEYWORDS = typesOf([
  "const", "volatile", "static", "extern", "mutable", "register", "thread_local", "inline", "virtual", "explicit",
  "friend", "constexpr", "typedef", "typename",
]);

/** `class`, `struct`, `union`, `enum`: what follows names a type. */
export const CLASS_KEYWORDS = typesOf(["class", "struct", "union", "enum"]);

/** What may follow the `>` closing template arguments: `vector<int> v`, `make<T>(…)`, `map<K, V>::iterator`. */
const AFTER_TEMPLATE: ReadonlySet<number> = new Set([
  CPP14Lexer.LeftParen, CPP14Lexer.RightParen, CPP14Lexer.Doublecolon, CPP14Lexer.LeftBrace, CPP14Lexer.Comma,
  CPP14Lexer.Semi, CPP14Lexer.Greater, CPP14Lexer.Identifier, CPP14Lexer.And, CPP14Lexer.AndAnd, CPP14Lexer.Star,
  CPP14Lexer.Ellipsis, CPP14Lexer.RightBracket, CPP14Lexer.Assign, CPP14Lexer.Colon, CPP14Lexer.Const,
  // `ready_v<T> == false`, `is_same_v<T, U> || …`: no comparison goes on with these after `>`.
  CPP14Lexer.Equal, CPP14Lexer.NotEqual, CPP14Lexer.OrOr, CPP14Lexer.Question,
]);

/** Casts whose `<` opens a type: brackets nested in a template's arguments. */
const CASTS: ReadonlySet<number> = new Set([CPP14Lexer.Static_cast, CPP14Lexer.Dynamic_cast, CPP14Lexer.Reinterpret_cast, CPP14Lexer.Const_cast]);

/** What ends a scan for a `<`'s `>`: the end of a statement or block, or a logical operator no argument holds. */
const ENDS_TEMPLATE: ReadonlySet<number> = new Set([
  CPP14Lexer.Semi, CPP14Lexer.LeftBrace, CPP14Lexer.RightBrace, CPP14Lexer.RightParen, CPP14Lexer.RightBracket,
  CPP14Lexer.AndAnd, CPP14Lexer.OrOr, CPP14Lexer.Question,
]);

/** After `&&` in template arguments, what makes it a reference: `Args&&...`, `T&&>`, `T&&,`. */
const RVALUE_SUFFIX: ReadonlySet<number> = new Set([CPP14Lexer.Ellipsis, CPP14Lexer.Greater, CPP14Lexer.Comma, CPP14Lexer.RightParen]);

/** What follows a declared name: `x;`, `x,`, `x =`, `x)`, `x[`, `x{`, `x:`. */
const AFTER_NAME: ReadonlySet<number> = new Set([
  CPP14Lexer.Semi, CPP14Lexer.Comma, CPP14Lexer.Assign, CPP14Lexer.RightParen, CPP14Lexer.LeftBracket,
  CPP14Lexer.LeftBrace, CPP14Lexer.Colon,
]);

/** A declaration may start after these: a statement or parameter boundary. */
const BOUNDARY: ReadonlySet<number> = new Set([
  CPP14Lexer.LeftParen, CPP14Lexer.Comma, CPP14Lexer.LeftBrace, CPP14Lexer.RightBrace, CPP14Lexer.Semi,
  CPP14Lexer.Colon,
]);

const OPENS: ReadonlyMap<number, number> = new Map([
  [CPP14Lexer.LeftParen, CPP14Lexer.RightParen],
  [CPP14Lexer.LeftBracket, CPP14Lexer.RightBracket],
  [CPP14Lexer.LeftBrace, CPP14Lexer.RightBrace],
]);

/** What no expression holds directly: a type keyword (but `int(x)`), a specifier, a block or a statement. */
const NON_EXPRESSION: ReadonlySet<number> = new Set([...TYPE_KEYWORDS, ...SPECIFIER_KEYWORDS, CPP14Lexer.LeftBrace, CPP14Lexer.Semi]);

/** What a cast's operand starts with: `(Club *) p`, `(int) -x`. */
const OPERAND_START: ReadonlySet<number> = new Set([
  CPP14Lexer.Identifier, CPP14Lexer.IntegerLiteral, CPP14Lexer.FloatingLiteral, CPP14Lexer.CharacterLiteral,
  CPP14Lexer.StringLiteral, CPP14Lexer.BooleanLiteral, CPP14Lexer.PointerLiteral, CPP14Lexer.UserDefinedLiteral,
  CPP14Lexer.LeftParen, CPP14Lexer.And, CPP14Lexer.Star, CPP14Lexer.Not, CPP14Lexer.Tilde, CPP14Lexer.Minus,
  CPP14Lexer.Plus, CPP14Lexer.Doublecolon, CPP14Lexer.This, CPP14Lexer.New, CPP14Lexer.Sizeof, CPP14Lexer.Nullptr,
  CPP14Lexer.PlusPlus, CPP14Lexer.MinusMinus, CPP14Lexer.Static_cast, CPP14Lexer.Dynamic_cast,
  CPP14Lexer.Reinterpret_cast, CPP14Lexer.Const_cast,
]);

/** An operand no expression in parentheses can be followed by, so the parentheses hold a type: `(Method) id`. */
const CAST_ONLY_OPERAND: ReadonlySet<number> = new Set([
  CPP14Lexer.Identifier, CPP14Lexer.IntegerLiteral, CPP14Lexer.FloatingLiteral, CPP14Lexer.CharacterLiteral,
  CPP14Lexer.StringLiteral, CPP14Lexer.BooleanLiteral, CPP14Lexer.PointerLiteral, CPP14Lexer.Not, CPP14Lexer.Tilde,
  CPP14Lexer.This, CPP14Lexer.New, CPP14Lexer.Sizeof, CPP14Lexer.Nullptr, CPP14Lexer.Doublecolon,
  CPP14Lexer.Static_cast, CPP14Lexer.Dynamic_cast, CPP14Lexer.Reinterpret_cast, CPP14Lexer.Const_cast,
]);

/** What a cast's `(` may follow: an operator, an opening bracket or separator, a keyword taking an operand. */
const BEFORE_CAST: ReadonlySet<number> = new Set([
  CPP14Lexer.Assign, CPP14Lexer.LeftParen, CPP14Lexer.Comma, CPP14Lexer.LeftBracket, CPP14Lexer.LeftBrace,
  CPP14Lexer.RightBrace, CPP14Lexer.Semi, CPP14Lexer.Question, CPP14Lexer.Colon, CPP14Lexer.Return, CPP14Lexer.Throw,
  CPP14Lexer.Case, CPP14Lexer.Co_return, CPP14Lexer.Co_await, CPP14Lexer.Co_yield, CPP14Lexer.Delete, CPP14Lexer.Not,
  CPP14Lexer.Tilde, CPP14Lexer.Minus, CPP14Lexer.Plus, CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.Div, CPP14Lexer.Mod,
  CPP14Lexer.Caret, CPP14Lexer.Or, CPP14Lexer.Less, CPP14Lexer.Greater, CPP14Lexer.Equal, CPP14Lexer.NotEqual,
  CPP14Lexer.LessEqual, CPP14Lexer.GreaterEqual, CPP14Lexer.AndAnd, CPP14Lexer.OrOr, CPP14Lexer.PlusAssign,
  CPP14Lexer.MinusAssign, CPP14Lexer.StarAssign, CPP14Lexer.DivAssign, CPP14Lexer.ModAssign, CPP14Lexer.XorAssign,
  CPP14Lexer.AndAssign, CPP14Lexer.OrAssign, CPP14Lexer.LeftShiftAssign, CPP14Lexer.RightShiftAssign,
  CPP14Lexer.PlusPlus, CPP14Lexer.MinusMinus,
]);

const POINTER: ReadonlySet<number> = new Set([CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.AndAnd]);

/** An all-caps macro name: `UNUSED`, `NO_CHECKS`; a name starting with `__` (`__attribute__`) is a compiler's. */
export const MACRO_NAME = /^[A-Z_][A-Z0-9_]*[A-Z][A-Z0-9_]*$/;

/** What the first pass knows of a file's tokens, indexed by `Token.tokenIndex`. */
export interface CppTokenFacts {
  /** The names used as types. */
  types: Set<string>;
  /** 1 where an identifier is one of `types`. */
  known: Uint8Array;
  /** 1 where an identifier is an all-caps macro name. */
  macro: Uint8Array;
  /** The bracket closing a `(`, `[` or `{`, or -1. */
  close: Int32Array;
  /** The `>` closing a `<` that opens template arguments, or -1. */
  angle: Int32Array;
  /** 1 where a `(` opens a C-style cast: a type in the parentheses, an operand after them. */
  cast: Uint8Array;
  /** 1 where an all-caps name calls a macro with arguments no expression reads: a type, `T *`, a block. */
  macroCall: Uint8Array;
  /** 1 where a `(` directly holds what no expression does: a type keyword, a specifier, `{`, `;`. */
  nonExpression: Uint8Array;
  /** The next token, or -1. */
  next: Int32Array;
}

export function readTypes(stream: CommonTokenStream): CppTokenFacts {
  stream.fill();
  const all = stream.getTokens();
  const tokens = all.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.type !== Token.EOF);
  const n = tokens.length;
  const type = (i: number) => tokens[i]?.type ?? -1;
  const isId = (i: number) => type(i) === CPP14Lexer.Identifier;
  const names: Array<string | undefined> = tokens.map((t) => (t.type === CPP14Lexer.Identifier ? t.text ?? "" : undefined));

  // Brackets, by position in `tokens`.
  const close = new Int32Array(n).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = type(i);
    if (OPENS.has(t)) open.push(i);
    else if (t === CPP14Lexer.RightParen || t === CPP14Lexer.RightBracket || t === CPP14Lexer.RightBrace) {
      // A stray closer pops nothing it does not match.
      let at = open.length - 1;
      while (at >= 0 && OPENS.get(type(open[at]!)) !== t) at--;
      if (at < 0) continue;
      close[open[at]!] = i;
      open.length = at;
    }
  }

  // Template arguments: a `<` after a name whose `>` comes before the statement ends, followed by what may follow one.
  const angle = new Int32Array(n).fill(-1);
  // `<<` is two `<` tokens with nothing between them: a shift, never a bracket.
  const shift = (i: number) =>
    (type(i + 1) === CPP14Lexer.Less && tokens[i + 1]!.start === tokens[i]!.stop + 1) || (type(i - 1) === CPP14Lexer.Less && tokens[i - 1]!.stop + 1 === tokens[i]!.start);
  for (let i = 0; i < n; i++) {
    if (type(i) !== CPP14Lexer.Less || shift(i) || !(isId(i - 1) || type(i - 1) === CPP14Lexer.Template || type(i - 1) === CPP14Lexer.Operator)) continue;
    let depth = 1;
    for (let j = i + 1; j < n; j++) {
      const t = type(j);
      if (OPENS.has(t) && t !== CPP14Lexer.LeftBrace) {
        if (close[j] < 0) break;
        j = close[j]!;
      } else if (t === CPP14Lexer.Less && !shift(j) && (isId(j - 1) || CASTS.has(type(j - 1)))) depth++;
      else if (t === CPP14Lexer.Greater && --depth === 0) {
        // `template <…>` opens a parameter list whatever follows it.
        if (AFTER_TEMPLATE.has(type(j + 1)) || j + 1 === n || type(i - 1) === CPP14Lexer.Template) angle[i] = j;
        break;
      } else if (t === CPP14Lexer.AndAnd && RVALUE_SUFFIX.has(type(j + 1))) continue;
      else if (ENDS_TEMPLATE.has(t)) break;
    }
  }

  const types = new Set<string>();
  const add = (i: number) => {
    if (isId(i)) types.add(names[i]!);
  };
  /** The position after a qualified name starting at `i` (`a::b<T>::c`), and its last name. */
  const pathAt = (i: number): { last: number; after: number } | null => {
    if (type(i) === CPP14Lexer.Doublecolon) i++;
    if (!isId(i)) return null;
    let last = i++;
    for (;;) {
      if (type(i) === CPP14Lexer.Less && angle[i]! >= 0) i = angle[i]! + 1;
      if (type(i) === CPP14Lexer.Doublecolon && isId(i + 1)) {
        last = i + 1;
        i += 2;
        continue;
      }
      return { last, after: i };
    }
  };
  const boundary = (i: number) => i === 0 || BOUNDARY.has(type(i - 1)) || SPECIFIER_KEYWORDS.has(type(i - 1)) || type(i - 1) === CPP14Lexer.Less;
  for (let i = 0; i < n; i++) {
    const t = type(i);
    // `class Club`, `struct EXPORT Club : Base`, `enum class Fixture`: the last name before the body or base.
    if (CLASS_KEYWORDS.has(t)) {
      let j = i + 1;
      if (CLASS_KEYWORDS.has(type(j))) j++;
      let name = -1;
      for (; j < n && j < i + 8; j++) {
        if (isId(j)) name = j;
        else if (type(j) === CPP14Lexer.Doublecolon) continue;
        else if (type(j) === CPP14Lexer.LeftParen && close[j]! >= 0) j = close[j]!;
        else break;
      }
      add(name);
      continue;
    }
    // `using Squad = …;`, `template <typename T, class U>`.
    if (t === CPP14Lexer.Using && isId(i + 1) && type(i + 2) === CPP14Lexer.Assign) add(i + 1);
    if ((t === CPP14Lexer.Typename_ || t === CPP14Lexer.Class) && isId(i + 1) && [CPP14Lexer.Comma, CPP14Lexer.Greater, CPP14Lexer.Assign, CPP14Lexer.Ellipsis].includes(type(i + 2))) add(i + 1);
    if (t === CPP14Lexer.Typedef) {
      let depth = 0;
      for (let j = i + 1; j < n; j++) {
        const u = type(j);
        if (u === CPP14Lexer.LeftBrace || u === CPP14Lexer.LeftParen) depth++;
        else if (u === CPP14Lexer.RightBrace || u === CPP14Lexer.RightParen) depth--;
        else if (u === CPP14Lexer.Semi && depth <= 0) break;
        if (!isId(j)) continue;
        if (depth === 0 && [CPP14Lexer.Semi, CPP14Lexer.Comma, CPP14Lexer.LeftBracket].includes(type(j + 1))) add(j);
        if (depth === 1 && type(j - 1) === CPP14Lexer.Star && type(j + 1) === CPP14Lexer.RightParen) add(j);
      }
    }
    if (isId(i) && names[i]!.endsWith("_t")) add(i);
    if (!isId(i) || type(i - 1) === CPP14Lexer.Dot || type(i - 1) === CPP14Lexer.Arrow || type(i - 1) === CPP14Lexer.Doublecolon) continue;
    const path = pathAt(i);
    if (!path) continue;
    const after = type(path.after);
    // `Club x;`, `const Club &c`, `std::vector<Club> squad(…)`, `Club *find(`: a declaration at its start.
    if (boundary(i) || type(i - 1) === CPP14Lexer.Const) {
      let j = path.after;
      while (type(j) === CPP14Lexer.Star || type(j) === CPP14Lexer.And || type(j) === CPP14Lexer.AndAnd || type(j) === CPP14Lexer.Const) j++;
      if (isId(j) && (AFTER_NAME.has(type(j + 1)) || type(j + 1) === CPP14Lexer.LeftParen) && !(after === CPP14Lexer.Star && type(i - 1) === CPP14Lexer.LeftParen && isId(i - 2))) add(path.last);
      // `(Club *)`, `(const Club &)`, `f(Club, int)`: an abstract declarator.
      if (j > path.after && (type(j) === CPP14Lexer.RightParen || type(j) === CPP14Lexer.Comma)) add(path.last);
    }
    // `new Club(…)`, `Club::Squad`: a type after `new`, a template's arguments read as types.
    if (type(i - 1) === CPP14Lexer.New) add(path.last);
  }
  // C-style casts: `(Club *) p`, `(int) x`, `(Method) id` — a type in parentheses where an operand may start, then one.
  const cast = new Uint8Array(n);
  const known = (i: number) => isId(i) && types.has(names[i]!);
  // `make<Club>(x)`: a template's `>` is no operator.
  const closesTemplate = new Set<number>();
  angle.forEach((c) => c >= 0 && closesTemplate.add(c));
  for (let i = 0; i < n; i++) {
    const c = close[i]!;
    if (type(i) !== CPP14Lexer.LeftParen || c < 0 || !OPERAND_START.has(type(c + 1))) continue;
    const prev = type(i - 1);
    // `operator++(int)`, `operator<<(…)`: an operator's parameters.
    if ([1, 2, 3].some((back) => type(i - back) === CPP14Lexer.Operator)) continue;
    // `(int)(long) x`: a cast's `)` may precede another.
    if (i > 0 && (!BEFORE_CAST.has(prev) || closesTemplate.has(i - 1)) && !(prev === CPP14Lexer.RightParen && cast[open_(i - 1)] === 1)) continue;
    let j = i + 1;
    while (SPECIFIER_KEYWORDS.has(type(j))) j++;
    if (TYPE_KEYWORDS.has(type(j)) && type(j) !== CPP14Lexer.Decltype) {
      while (TYPE_KEYWORDS.has(type(j)) || SPECIFIER_KEYWORDS.has(type(j)) || POINTER.has(type(j))) j++;
      if (j === c) cast[i] = 1;
      continue;
    }
    const path = pathAt(j);
    if (!path) continue;
    const operand = type(c + 1);
    // `(a) - b` subtracts, `(f)(x)` calls; `(Club) x` casts.
    if (path.after === c) {
      if (CAST_ONLY_OPERAND.has(operand) || (known(path.last) && operand !== CPP14Lexer.Minus && operand !== CPP14Lexer.Plus)) cast[i] = 1;
      continue;
    }
    let k = path.after;
    while (POINTER.has(type(k)) || type(k) === CPP14Lexer.Const) k++;
    if (k === c && k !== path.after) cast[i] = 1;
  }
  // `SIGNAL(moved(Club *))`, `Q_PROPERTY(int goals READ goals)`: arguments only a macro takes.
  const macroCall = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // An all-caps class the file declares (`DB(const DB &)`) is no macro.
    if (!isId(i) || !MACRO_NAME.test(names[i]!) || types.has(names[i]!) || type(i + 1) !== CPP14Lexer.LeftParen || close[i + 1]! < 0) continue;
    for (let j = i + 2; j < close[i + 1]!; j++) {
      const t = type(j);
      if (NON_EXPRESSION.has(t) || (POINTER.has(t) && (type(j + 1) === CPP14Lexer.RightParen || type(j + 1) === CPP14Lexer.Comma))) {
        macroCall[i] = 1;
        break;
      }
    }
  }
  return facts(all, tokens, names, types, close, angle, cast, macroCall);

  /** The `(` a `)` at `i` closes. */
  function open_(i: number): number {
    for (let o = i - 1; o >= 0; o--) if (close[o] === i) return o;
    return -1;
  }
}

function facts(
  all: Token[],
  tokens: Token[],
  names: Array<string | undefined>,
  types: Set<string>,
  close: Int32Array,
  angle: Int32Array,
  cast: Uint8Array,
  macroCall: Uint8Array,
): CppTokenFacts {
  const size = all.length;
  const out: CppTokenFacts = {
    types,
    known: new Uint8Array(size),
    macro: new Uint8Array(size),
    close: new Int32Array(size).fill(-1),
    angle: new Int32Array(size).fill(-1),
    cast: new Uint8Array(size),
    macroCall: new Uint8Array(size),
    nonExpression: new Uint8Array(size),
    next: new Int32Array(size).fill(-1),
  };
  // The innermost open `(` at each token: a type keyword or block there is not an expression's.
  const parens: number[] = [];
  tokens.forEach((t) => {
    if (t.type === CPP14Lexer.LeftParen) parens.push(t.tokenIndex);
    else if (t.type === CPP14Lexer.RightParen) parens.pop();
    else if (parens.length > 0 && (NON_EXPRESSION.has(t.type))) out.nonExpression[parens.at(-1)!] = 1;
  });
  tokens.forEach((t, i) => {
    const k = t.tokenIndex;
    out.next[k] = tokens[i + 1]?.tokenIndex ?? -1;
    if (close[i]! >= 0) out.close[k] = tokens[close[i]!]!.tokenIndex;
    if (angle[i]! >= 0) out.angle[k] = tokens[angle[i]!]!.tokenIndex;
    if (cast[i] === 1) out.cast[k] = 1;
    if (macroCall[i] === 1) out.macroCall[k] = 1;
    const name = names[i];
    if (name === undefined) return;
    if (types.has(name)) out.known[k] = 1;
    if (MACRO_NAME.test(name) || name.startsWith("__")) out.macro[k] = 1;
  });
  return out;
}
