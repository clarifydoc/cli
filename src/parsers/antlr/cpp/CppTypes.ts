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
  "void", "char", "char8_t", "char16_t", "char32_t", "wchar_t", "bool", "short", "int", "long", "float", "double", "signed",
  "unsigned", "auto", "decltype",
]);

/** Keywords a declaration may start with besides a type: storage classes, qualifiers, function specifiers. */
export const SPECIFIER_KEYWORDS = typesOf([
  "const", "volatile", "static", "extern", "mutable", "register", "thread_local", "inline", "virtual", "explicit",
  "friend", "constexpr", "consteval", "constinit", "typedef", "typename",
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
  // `struct from<Cup, T> final {`.
  CPP14Lexer.Final, CPP14Lexer.Override,
  // A variable template's member or element, `names_v<T>.size()`, `ids_v<T>[0]`; an attribute after a requires clause.
  CPP14Lexer.Dot, CPP14Lexer.LeftBracket,
  // `size_v<T> / 2`, `{v.data, extent_v<V>}`, `view<Opts> operator[](…)`: no comparison goes on with these either.
  CPP14Lexer.Div, CPP14Lexer.Mod, CPP14Lexer.RightBrace, CPP14Lexer.Operator, CPP14Lexer.Or, CPP14Lexer.Caret,
]);

/** A declaration's keywords, which follow a template only: `requires Kickable<T> void play(`. */
const AFTER_TEMPLATE_KEYWORDS = typesOf([
  "void", "char", "char8_t", "char16_t", "char32_t", "wchar_t", "bool", "short", "int", "long", "float", "double",
  "signed", "unsigned", "auto", "const", "volatile", "static", "extern", "inline", "virtual", "explicit", "friend",
  "constexpr", "consteval", "constinit", "typename", "class", "struct", "union", "enum", "template", "requires",
]);

/** What a template lambda's parameter list starts with: `<typename T>`, `<auto I>`, `<size_t N>`. */
const TEMPLATE_PARAMETER_START: ReadonlySet<number> = new Set([CPP14Lexer.Typename_, CPP14Lexer.Class, CPP14Lexer.Auto, CPP14Lexer.Identifier, CPP14Lexer.Int, CPP14Lexer.Bool, CPP14Lexer.Char, CPP14Lexer.Unsigned, CPP14Lexer.Long]);

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

/** The keywords whose parenthesized header a statement follows. */
const CONTROL_HEADER: ReadonlySet<number> = new Set([CPP14Lexer.If, CPP14Lexer.While, CPP14Lexer.For, CPP14Lexer.Switch]);

/** What only an expression's parentheses follow: `= (a & b)`, `return (a * b)`, `x && (a & b)`. */
const EXPRESSION_BEFORE: ReadonlySet<number> = new Set([
  CPP14Lexer.Assign, CPP14Lexer.Return, CPP14Lexer.PlusAssign, CPP14Lexer.MinusAssign, CPP14Lexer.StarAssign,
  CPP14Lexer.DivAssign, CPP14Lexer.ModAssign, CPP14Lexer.XorAssign, CPP14Lexer.AndAssign, CPP14Lexer.OrAssign,
  CPP14Lexer.AndAnd, CPP14Lexer.OrOr, CPP14Lexer.Equal, CPP14Lexer.NotEqual, CPP14Lexer.Question, CPP14Lexer.Not,
  CPP14Lexer.Plus, CPP14Lexer.Minus, CPP14Lexer.Div, CPP14Lexer.Mod, CPP14Lexer.Or, CPP14Lexer.Caret,
  CPP14Lexer.LessEqual, CPP14Lexer.GreaterEqual,
]);

/** What a cast's operand starts with: `(Club *) p`, `(int) -x`. */
const OPERAND_START: ReadonlySet<number> = new Set([
  CPP14Lexer.Identifier, CPP14Lexer.IntegerLiteral, CPP14Lexer.FloatingLiteral, CPP14Lexer.CharacterLiteral,
  CPP14Lexer.StringLiteral, CPP14Lexer.BooleanLiteral, CPP14Lexer.PointerLiteral, CPP14Lexer.UserDefinedLiteral,
  CPP14Lexer.LeftParen, CPP14Lexer.And, CPP14Lexer.Star, CPP14Lexer.Not, CPP14Lexer.Tilde, CPP14Lexer.Minus,
  CPP14Lexer.Plus, CPP14Lexer.Doublecolon, CPP14Lexer.This, CPP14Lexer.New, CPP14Lexer.Sizeof, CPP14Lexer.Nullptr,
  CPP14Lexer.PlusPlus, CPP14Lexer.MinusMinus, CPP14Lexer.Static_cast, CPP14Lexer.Dynamic_cast,
  CPP14Lexer.Reinterpret_cast, CPP14Lexer.Const_cast,
  CPP14Lexer.Operator,
]);

/** An operand no expression in parentheses can be followed by, so the parentheses hold a type: `(Method) id`. */
const CAST_ONLY_OPERAND: ReadonlySet<number> = new Set([
  CPP14Lexer.Identifier, CPP14Lexer.IntegerLiteral, CPP14Lexer.FloatingLiteral, CPP14Lexer.CharacterLiteral,
  CPP14Lexer.StringLiteral, CPP14Lexer.BooleanLiteral, CPP14Lexer.PointerLiteral, CPP14Lexer.Not, CPP14Lexer.Tilde,
  CPP14Lexer.This, CPP14Lexer.New, CPP14Lexer.Sizeof, CPP14Lexer.Nullptr, CPP14Lexer.Doublecolon,
  CPP14Lexer.Static_cast, CPP14Lexer.Dynamic_cast, CPP14Lexer.Reinterpret_cast, CPP14Lexer.Const_cast,
  CPP14Lexer.Operator,
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

/** Where a bare macro statement or declaration may start. */
const BARE_MACRO_AFTER: ReadonlySet<number> = new Set([CPP14Lexer.Semi, CPP14Lexer.LeftBrace, CPP14Lexer.RightBrace]);

/** What only starts a statement or a declaration, so a bare macro may stand before it. */
const BARE_MACRO_BEFORE: ReadonlySet<number> = new Set([
  CPP14Lexer.LeftBrace, CPP14Lexer.If, CPP14Lexer.For, CPP14Lexer.While, CPP14Lexer.Do,
  CPP14Lexer.Switch, CPP14Lexer.Return, CPP14Lexer.Break, CPP14Lexer.Continue, CPP14Lexer.Goto, CPP14Lexer.Try,
  CPP14Lexer.Throw, CPP14Lexer.Co_return, CPP14Lexer.Namespace, CPP14Lexer.Class, CPP14Lexer.Struct, CPP14Lexer.Union,
  CPP14Lexer.Enum, CPP14Lexer.Template, CPP14Lexer.Using, CPP14Lexer.Typedef, CPP14Lexer.Extern,
]);

/** The operators a fold expression folds over. */
const FOLD_OPERATORS: ReadonlySet<number> = new Set([
  CPP14Lexer.Plus, CPP14Lexer.Minus, CPP14Lexer.Star, CPP14Lexer.Div, CPP14Lexer.Mod, CPP14Lexer.Caret, CPP14Lexer.And,
  CPP14Lexer.Or, CPP14Lexer.Less, CPP14Lexer.Greater, CPP14Lexer.Equal, CPP14Lexer.NotEqual, CPP14Lexer.LessEqual,
  CPP14Lexer.GreaterEqual, CPP14Lexer.AndAnd, CPP14Lexer.OrOr, CPP14Lexer.Comma, CPP14Lexer.Assign,
  CPP14Lexer.PlusAssign, CPP14Lexer.MinusAssign, CPP14Lexer.StarAssign, CPP14Lexer.DivAssign, CPP14Lexer.OrAssign,
  CPP14Lexer.AndAssign,
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
  /** 1 where a `(` holds a C++17 fold expression: `...` beside an operator at its own depth. */
  fold: Uint8Array;
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
  // 1 inside the arguments of a template whose arguments may hold logical operators: so may the templates' there.
  const inArguments = new Uint8Array(n);
  // `<<` is two `<` tokens with nothing between them: a shift, never a bracket.
  const shift = (i: number) =>
    (type(i + 1) === CPP14Lexer.Less && tokens[i + 1]!.start === tokens[i]!.stop + 1) || (type(i - 1) === CPP14Lexer.Less && tokens[i - 1]!.stop + 1 === tokens[i]!.start);
  for (let i = 0; i < n; i++) {
    // `[&]<auto I>(…)`: a template lambda's parameters, after the introducer's `]`.
    const lambda = type(i - 1) === CPP14Lexer.RightBracket && TEMPLATE_PARAMETER_START.has(type(i + 1));
    // `f.template operator()<I>()`: a call operator's template arguments.
    const callOperator = type(i - 1) === CPP14Lexer.RightParen && type(i - 2) === CPP14Lexer.LeftParen && type(i - 3) === CPP14Lexer.Operator;
    if (type(i) !== CPP14Lexer.Less || shift(i) || !(isId(i - 1) || type(i - 1) === CPP14Lexer.Template || type(i - 1) === CPP14Lexer.Operator || lambda || callOperator)) continue;
    let depth = 1;
    // `std::enable_if<!A::value && B>`: after a qualified name the `<` is a template's, whose constant arguments may
    // hold logical operators; elsewhere `&&` ends the scan (`if (a < b && c > d)`).
    // So may a template's parameters, `template <class T, bool B = A<T>::value && C>`, and an alias's type,
    // `using Bits = conditional_t<size<T>() <= 32 && B, int, long>`.
    const alias = type(i - 2) === CPP14Lexer.Assign && type(i - 4) === CPP14Lexer.Using;
    // A class head's, `struct formatter<T, enable_if_t<A || B>>`, and any inside one of these.
    const head = CLASS_KEYWORDS.has(type(i - 2));
    const qualified = type(i - 2) === CPP14Lexer.Doublecolon || type(i - 1) === CPP14Lexer.Template || alias || head || inArguments[i] === 1;
    // `bool_constant<is_integral<T>::value && …>`: a template's member constant before the operator.
    const constant = (j: number) => isId(j - 1) && type(j - 2) === CPP14Lexer.Doublecolon && type(j - 3) === CPP14Lexer.Greater;
    // The `>` closing the last template inside these arguments: `to_sv<is_copyable_v<T> && B>` holds the `&&`.
    let nested = -1;
    // A `,` among the arguments: `f(a < b, c > -1)` compares twice, `count_v<T, X> - 1` subtracts.
    let comma = false;
    for (let j = i + 1; j < n; j++) {
      const t = type(j);
      // `write<Opts{.indent = 2}>(…)`: a braced initializer among the arguments; any other `{` ends the scan.
      if (OPENS.has(t) && (t !== CPP14Lexer.LeftBrace || isId(j - 1) || type(j - 1) === CPP14Lexer.Greater)) {
        if (close[j] < 0) break;
        j = close[j]!;
      } else if (t === CPP14Lexer.Less && !shift(j) && (isId(j - 1) || CASTS.has(type(j - 1)) || type(j - 1) === CPP14Lexer.Template)) depth++;
      else if (t === CPP14Lexer.Greater && --depth > 0) nested = j;
      else if (t === CPP14Lexer.Comma && depth === 1 && (comma = true)) continue;
      else if (t === CPP14Lexer.Greater) {
        // `template <…>` opens a parameter list whatever follows it; `name_v<T> << "x"` shifts after it.
        const shifted = type(j + 1) === CPP14Lexer.Less && shift(j + 1);
        // After `=` or `return` a `,` would make a comma expression: `n = count_v<T, X> + 1`.
        const initializer = type(i - 2) === CPP14Lexer.Assign || type(i - 2) === CPP14Lexer.Return;
        const sign = (type(j + 1) === CPP14Lexer.Plus || type(j + 1) === CPP14Lexer.Minus) && (!comma || qualified || initializer);
        if (AFTER_TEMPLATE.has(type(j + 1)) || sign || AFTER_TEMPLATE_KEYWORDS.has(type(j + 1)) || shifted || j + 1 === n || type(i - 1) === CPP14Lexer.Template) {
          angle[i] = j;
          if (qualified) inArguments.fill(1, i + 1, j);
        }
        break;
      } else if (t === CPP14Lexer.AndAnd && (qualified || constant(j) || nested === j - 1 || RVALUE_SUFFIX.has(type(j + 1)))) continue;
      else if (t === CPP14Lexer.OrOr && (qualified || constant(j) || nested === j - 1)) continue;
      // `integral_constant<F, same<T> ? A : B>`.
      else if (t === CPP14Lexer.Question && qualified) continue;
      // `x = y ? a < b : c > d` compares: a `:` stands in arguments only after their `?`.
      else if (t === CPP14Lexer.Colon && !qualified) break;
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
    // `Club x;`, `const Club &c`, `std::vector<Club> squad(…)`, `Club *find(`: a declaration at its start — never in
    // parentheses an operator opens, `lhs = (lhs & rhs)`, but for an operator's parameters, `operator&(Club lhs, …)`.
    const inExpression = type(i - 1) === CPP14Lexer.LeftParen && EXPRESSION_BEFORE.has(type(i - 2)) && type(i - 3) !== CPP14Lexer.Operator;
    if ((boundary(i) || type(i - 1) === CPP14Lexer.Const) && !inExpression) {
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
    // `operator++(int)`, `operator<<(…)`: an operator's parameters, but not `operator new((size_t)8)`'s argument.
    if (prev !== CPP14Lexer.LeftParen && [1, 2, 3].some((back) => type(i - back) === CPP14Lexer.Operator)) continue;
    // `(int)(long) x`: a cast's `)` may precede another, and a statement starts after a control header's,
    // `for (…) (void)kick(…);`.
    if (i > 0 && (!BEFORE_CAST.has(prev) || closesTemplate.has(i - 1)) && !(prev === CPP14Lexer.RightParen && castAfterParen(i - 1))) continue;
    let j = i + 1;
    // `(const Club *)`, `(struct sockaddr *)`.
    while (SPECIFIER_KEYWORDS.has(type(j)) || CLASS_KEYWORDS.has(type(j))) j++;
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
    // `Resolver::CIDR::CIDR(…)`, `p->MAX(…)`: a member or a qualified name is no macro.
    if (type(i - 1) === CPP14Lexer.Doublecolon || type(i - 1) === CPP14Lexer.Dot || type(i - 1) === CPP14Lexer.Arrow) continue;
    for (let j = i + 2; j < close[i + 1]!; j++) {
      const t = type(j);
      if (NON_EXPRESSION.has(t) || (POINTER.has(t) && (type(j + 1) === CPP14Lexer.RightParen || type(j + 1) === CPP14Lexer.Comma))) {
        macroCall[i] = 1;
        break;
      }
    }
  }
  // `BENCHMARK_LOOP {`, `SET_SOURCE_PATH return …`, `BEGIN_NAMESPACE class …`: a bare macro where a statement or
  // declaration starts, before what only starts another — a name alone there would be an expression.
  for (let i = 0; i < n; i++) {
    // After another bare macro too: `BEGIN_NAMESPACE BEGIN_EXPORT template …`.
    if (!isId(i) || !MACRO_NAME.test(names[i]!) || types.has(names[i]!) || (i > 0 && !BARE_MACRO_AFTER.has(type(i - 1)) && macroCall[i - 1] !== 1)) continue;
    const next = type(i + 1);
    if (BARE_MACRO_BEFORE.has(next) || i + 1 === n || (isId(i + 1) && MACRO_NAME.test(names[i + 1]!) && type(i + 2) !== CPP14Lexer.Semi)) macroCall[i] = 1;
  }
  // `if CONSTEXPR20 (…)`: a macro standing for `constexpr`.
  for (let i = 1; i < n; i++) if (type(i - 1) === CPP14Lexer.If && isId(i) && MACRO_NAME.test(names[i]!) && type(i + 1) === CPP14Lexer.LeftParen) macroCall[i] = 1;
  // `(std::cout << ... << args)`, `(check(args) && ...)`: a fold, its `...` beside an operator at the parentheses' depth.
  const fold = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // A fold's own parentheses stand where an operand may start; after a name they are a call's or a parameter list's
    // (`run(Args &&...args)`); after `requires` they hold a constraint, `requires (Comparable<Ts> && ...)`.
    const prev = type(i - 1);
    // After a cast too, `(void)(kick(p), ...)`.
    const afterCast = prev === CPP14Lexer.RightParen && cast[open_(i - 1)] === 1;
    if (type(i) !== CPP14Lexer.LeftParen || close[i]! < 0 || (i > 0 && prev !== CPP14Lexer.Requires && !afterCast && (!BEFORE_CAST.has(prev) || closesTemplate.has(i - 1)))) continue;
    for (let j = i + 1; j < close[i]!; j++) {
      if (OPENS.has(type(j)) && close[j]! >= 0) {
        j = close[j]!;
        continue;
      }
      // `(make_seq<Ts...>{})` expands a pack in template arguments.
      if (angle[j]! >= 0) {
        j = angle[j]!;
        continue;
      }
      // `void log(const char *fmt, ...)` is a variadic parameter list: a comma folds only after a call, `(kick(p), ...)`.
      const before = type(j - 1) === CPP14Lexer.Comma ? type(j - 2) === CPP14Lexer.RightParen : FOLD_OPERATORS.has(type(j - 1));
      if (type(j) === CPP14Lexer.Ellipsis && (before || (FOLD_OPERATORS.has(type(j + 1)) && type(j + 1) !== CPP14Lexer.Comma))) {
        fold[i] = 1;
        break;
      }
    }
  }
  return facts(all, tokens, names, types, close, angle, cast, macroCall, fold);

  /** Whether a cast may follow the `)` at `i`: another cast's, or a control header's. */
  function castAfterParen(i: number): boolean {
    const open = open_(i);
    return open >= 0 && (cast[open] === 1 || CONTROL_HEADER.has(type(open - 1)));
  }

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
  fold: Uint8Array,
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
    fold: new Uint8Array(size),
    nonExpression: new Uint8Array(size),
    next: new Int32Array(size).fill(-1),
  };
  // `#define std_trait(x) …`: a function-like macro the file defines, whatever its case.
  const defined = new Set<string>();
  for (const t of all) {
    if (t.type !== CPP14Lexer.Directive && t.type !== CPP14Lexer.MultiLineMacro) continue;
    const m = /^#\s*define\s+(\w+)\(/.exec(t.text ?? "");
    if (m) defined.add(m[1]!);
  }
  // The innermost open `(` at each token: a type keyword or block there is not an expression's — a `{` after a name or
  // template arguments is a braced temporary, `(Seq<Ts...>{})`.
  const closesTemplate = new Set<number>();
  angle.forEach((c) => c >= 0 && closesTemplate.add(c));
  const parens: number[] = [];
  tokens.forEach((t, i) => {
    if (t.type === CPP14Lexer.LeftParen) parens.push(t.tokenIndex);
    else if (t.type === CPP14Lexer.RightParen) parens.pop();
    else if (parens.length > 0 && NON_EXPRESSION.has(t.type)) {
      const braced = t.type === CPP14Lexer.LeftBrace && i > 0 && (tokens[i - 1]!.type === CPP14Lexer.Identifier || closesTemplate.has(i - 1));
      if (!braced) out.nonExpression[parens.at(-1)!] = 1;
    }
  });
  tokens.forEach((t, i) => {
    const k = t.tokenIndex;
    out.next[k] = tokens[i + 1]?.tokenIndex ?? -1;
    if (close[i]! >= 0) out.close[k] = tokens[close[i]!]!.tokenIndex;
    if (angle[i]! >= 0) out.angle[k] = tokens[angle[i]!]!.tokenIndex;
    if (cast[i] === 1) out.cast[k] = 1;
    if (macroCall[i] === 1) out.macroCall[k] = 1;
    if (fold[i] === 1) out.fold[k] = 1;
    const name = names[i];
    if (name === undefined) return;
    if (types.has(name)) out.known[k] = 1;
    if (MACRO_NAME.test(name) || name.startsWith("__") || (defined.has(name) && tokens[i + 1]?.type === CPP14Lexer.LeftParen)) out.macro[k] = 1;
  });
  return out;
}
