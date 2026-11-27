/*
 * The first of the C reading's two passes: the names a file uses as types, which the parser's predicates
 * (CParserBase.ts) read as typedef names. A compiler learns them from the headers `gcc -E` pulls in; an analyzer
 * without the build's include paths learns them from how the file itself uses them. The pass also answers, once
 * per token, what the predicates would otherwise recompute at every prediction.
 */
import { Token, type CommonTokenStream } from "antlr4ng";
import { CLexer } from "./CLexer.js";
import { STATEMENT_KEYWORDS, SPECIFIER_KEYWORDS, BEFORE_MACRO_KEYWORDS, LEADING_KEYWORDS, NOT_BEFORE_CAST, QUALIFIER_KEYWORDS, TAG_KEYWORDS, TYPE_KEYWORDS, TYPEDEF, BLOCK_HEAD_KEYWORDS, BLOCK_KEYWORDS, CALLING_KEYWORDS } from "./CKeywords.js";

/** Types every C program sees through the standard headers. */
const STANDARD = ["FILE", "DIR", "va_list", "jmp_buf", "sigjmp_buf", "bool", "wchar_t", "fd_set", "sigset_t", "locale_t"];

/** Operators that only stand between two operands: beside a `,` or a parenthesis they leave no expression (`check_int(a, ==, b)`). */
const BINARY_ONLY: ReadonlySet<number> = new Set([
  CLexer.Equal, CLexer.NotEqual, CLexer.Less, CLexer.Greater, CLexer.LessEqual, CLexer.GreaterEqual, CLexer.Div, CLexer.Mod,
  CLexer.Or, CLexer.AndAnd, CLexer.OrOr, CLexer.LeftShift, CLexer.RightShift, CLexer.Question,
]);

/** Where a bare macro may start a statement or declaration. */
const BARE_AFTER: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.LeftBrace, CLexer.RightBrace, CLexer.Colon]);

/** An all-caps macro name: `UNUSED`, `NO_CHECKS`, `PRINTF_LIKE`. */
/** Where a declaration starts, for a macro standing for its type. */
const DECLARATION_BOUNDARY: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.LeftBrace, CLexer.RightBrace, ...TYPEDEF, ...LEADING_KEYWORDS]);

/** What ends a declarator. */
const DECLARATOR_END: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.Comma, CLexer.LeftBracket, CLexer.Assign, CLexer.RightParen]);

export const MACRO_NAME = /^[A-Z_][A-Z0-9_]*[A-Z][A-Z0-9_]*$/;

/** The one-capital names a file defines as function-like macros (`#define X(a, b)`), which an X-macro list calls. */
const SINGLE_DEFINE = /^#\s*define\s+([A-Z])\(/;

/** What follows a declared name: `x;`, `x,`, `x =`, `x)`, `x[`, `x:` (a bit field). */
const AFTER_NAME: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.Comma, CLexer.Assign, CLexer.RightParen, CLexer.LeftBracket, CLexer.Colon]);

/** What may follow a cast `(T)`: an operand, or `{` for a compound literal. */
const OPERAND: ReadonlySet<number> = new Set([
  CLexer.Identifier, CLexer.IntegerConstant, CLexer.FloatingConstant, CLexer.CharacterConstant, CLexer.StringLiteral,
  CLexer.And, CLexer.Star, CLexer.Not, CLexer.Tilde, CLexer.Minus, CLexer.LeftBrace,
]);

/** What the first pass knows of a file's tokens, indexed by `Token.tokenIndex`. */
export interface CTokenFacts {
  /** The names used as types. */
  types: Set<string>;
  /** 1 where an identifier is one of `types`. */
  known: Uint8Array;
  /** 1 where an identifier is an all-caps macro name. */
  macro: Uint8Array;
  /** The `)` matching a `(`, or -1. */
  close: Int32Array;
  /** 1 where a `(` holds a `{` or `;` of its own: a macro's block argument (`EACH(x, { … })`), no expression. */
  blockArg: Uint8Array;
  /** 1 where a name, with its arguments if any, stands beside a string literal it joins: `"x" QUOTE(n) VERSION "y"`. */
  stringMacro: Uint8Array;
  /** The token type a name is retyped to (`MacroName`, `CallingConvention`, `StringMacro`), or 0. */
  retype: Int32Array;
  /** The next token on the default channel, or -1. */
  next: Int32Array;
}

/**
 * The names the file uses as types, read off its tokens where only a type can stand: its own typedefs, a run of
 * names ending in a declared one (`foo_t x;`, `static leagueAtomic matchFlag x = …`, `void pit_cdecl⏎f(`), `T *x,` /
 * `T *f(` at a declaration's start, abstract declarators (`(const BYTE *)`), `(T) x` casts and compound literals, a
 * name directly before a type keyword (a specifier macro), plus the `_t` convention and the standard library's
 * types. A name after `struct`, `union` or `enum` is a tag, never a typedef name.
 */
/** 1 where the innermost brace around a token opens a struct or union body (`struct s {`, `union {`). */
function tagBodies(tokens: Token[]): Uint8Array {
  const out = new Uint8Array(tokens.length);
  const stack: boolean[] = [];
  const type = (i: number) => tokens[i]?.type ?? -1;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.RightBrace) stack.pop();
    else if (stack.at(-1)) out[i] = 1;
    if (t.type !== CLexer.LeftBrace) return;
    const named = type(i - 1) === CLexer.Identifier && (type(i - 2) === CLexer.Struct || type(i - 2) === CLexer.Union);
    stack.push(named || type(i - 1) === CLexer.Struct || type(i - 1) === CLexer.Union);
  });
  return out;
}

/** 1 where the innermost brace around a token opens an enum body (`enum e {`, `typedef enum {`). */
function enumBodies(tokens: Token[]): Uint8Array {
  const out = new Uint8Array(tokens.length);
  const stack: boolean[] = [];
  const type = (i: number) => tokens[i]?.type ?? -1;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.RightBrace) stack.pop();
    else if (stack.at(-1)) out[i] = 1;
    if (t.type !== CLexer.LeftBrace) return;
    stack.push(type(i - 1) === CLexer.Enum || (type(i - 1) === CLexer.Identifier && type(i - 2) === CLexer.Enum));
  });
  return out;
}

/**
 * Macros that stand where no grammar rule has them go to the hidden channel, so the parser reads the code around
 * them: the macro written before a cast's parentheses (`t->data = CLUB_DATA_T (uintptr_t) 0;`), and a list macro
 * between the entries of an initializer, bare or with arguments (`ALL_ENTRIES`, `FOR_EACH_EXTRA(EMIT)`), where only
 * a comma could stand. The same pass sets aside a macro in a cast's type, after an attribute, a call between a `*` and
 * the declared function's name, a name between a type and an attribute that precedes the declared name or between a
 * prototype's parameters and its attribute, one after `[` before a called name, and names alone before a struct
 * body's `}` or ending a file, one between a basic type keyword and a `*` (`void CLUB_NOTHROW *name(`), and a list macro (called or bare) before an enum's next name where no comma stands, and
 * two or more bare macros at a struct member's start before its type (`CLUB_A⏎CLUB_B⏎int x;`).
 */
function hideMacros(all: Token[]): void {
  const tokens = all.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.type !== Token.EOF);
  const n = tokens.length;
  const type = (i: number) => tokens[i]?.type ?? -1;
  const close = new Int32Array(n).fill(-1);
  const open: number[] = [];
  for (let i = 0; i < n; i++) {
    if (type(i) === CLexer.LeftParen) open.push(i);
    else if (type(i) === CLexer.RightParen && open.length > 0) close[open.pop()!] = i;
  }
  const opened = new Map<number, number>();
  close.forEach((c, o) => c >= 0 && opened.set(c, o));
  /** The `)` at `i` closes the parentheses of `__attribute__`. */
  const closesAttribute = (i: number) => type((opened.get(i) ?? 0) - 1) === CLexer.Attribute;
  /** The token at `i` ends a type: `*`, a name or a type keyword other than a storage class or qualifier. */
  const completeTypeBefore = (i: number) => type(i - 1) === CLexer.Star || type(i - 1) === CLexer.Identifier || TYPE_KEYWORDS.has(type(i - 1));
  const hide = (from: number, to: number) => {
    for (let k = from; k <= to; k++) (tokens[k] as { channel: number }).channel = Token.HIDDEN_CHANNEL;
  };
  const tagBody = tagBodies(tokens);
  const enumBody = enumBodies(tokens);
  // Initializer braces: the `{` after `=`, and the braces of its entries.
  const stack: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const t = type(i);
    if (t === CLexer.RightBrace) {
      stack.pop();
      continue;
    }
    if (t === CLexer.LeftBrace) {
      const before = type(i - 1);
      stack.push(before === CLexer.Assign || (stack.at(-1) === true && (before === CLexer.LeftBrace || before === CLexer.Comma || before === CLexer.RightBrace)));
      continue;
    }
    if (t !== CLexer.Identifier) continue;
    const name = tokens[i]!.text ?? "";
    const prev = type(i - 1);
    if (prev === CLexer.Dot || prev === CLexer.Arrow) continue;
    const called = type(i + 1) === CLexer.LeftParen && close[i + 1]! >= 0;
    const after = type(called ? close[i + 1]! + 1 : i + 1);
    // `club_u64 *CLUB_RESTRICT const acc`: a macro between a `*` and a qualifier keyword stands for part of the pointer
    // (the grammar's pointer takes a calling convention or qualifiers, not both); no expression has a name there.
    if (MACRO_NAME.test(name) && prev === CLexer.Star && !called && QUALIFIER_KEYWORDS.has(type(i + 1))) {
      hide(i, i);
      continue;
    }
    // `void CLUB_NOTHROW *⏎club_malloc(`: a macro between a basic type keyword and a `*` stands for part of the type; a
    // keyword is never followed by a declarator that a `*` then follows. A tag keyword (`struct CLUB *`) names a tag.
    if (MACRO_NAME.test(name) && !called && TYPE_KEYWORDS.has(prev) && !TAG_KEYWORDS.has(prev) && type(i + 1) === CLexer.Star) {
      hide(i, i);
      continue;
    }
    // `const char * FORMAT_ARG(3)⏎name(`: a macro call between a `*` and the declared function's name — an expression
    // never has a name after a call.
    // Several may stand there (`void * CLUB_ATTR(malloc) CLUB_SIZE(1)⏎name(`): each is called, the declared name last.
    if (MACRO_NAME.test(name) && called && prev === CLexer.Star) {
      let end = close[i + 1]!;
      while (type(end + 1) === CLexer.Identifier && MACRO_NAME.test(tokens[end + 1]!.text ?? "") && type(end + 2) === CLexer.LeftParen && close[end + 2]! >= 0) end = close[end + 2]!;
      if (type(end + 1) === CLexer.Identifier && type(end + 2) === CLexer.LeftParen) {
        hide(i, end);
        i = end;
        continue;
      }
    }
    // `static int⏎club_internal __attribute ((pure))⏎name(`: a name between a whole type and an attribute that is
    // followed by the declared name is a macro, as is the one after it (`static __attribute__ ((unused)) club_t f(`).
    if (type(i + 1) === CLexer.Attribute && type(i + 2) === CLexer.LeftParen && close[i + 2]! >= 0 && completeTypeBefore(i)
      && type(close[i + 2]! + 1) === CLexer.Identifier && type(close[i + 2]! + 2) === CLexer.LeftParen) {
      hide(i, i);
      continue;
    }
    // `int f(int n) club_internal __attribute ((pure));`: a name between a prototype's parameters and its attribute.
    if (prev === CLexer.RightParen && type(i + 1) === CLexer.Attribute && type(i + 2) === CLexer.LeftParen && close[i + 2]! >= 0
      && (type(close[i + 2]! + 1) === CLexer.Semi || type(close[i + 2]! + 1) === CLexer.Comma) && !closesAttribute(i - 1)) {
      hide(i, i);
      continue;
    }
    // `m[_Club_restrict_ CLUB_LEN (n)]`: a macro right after `[` and before a called name qualifies the bound.
    if ((MACRO_NAME.test(name) || name.startsWith("__") || /^_[A-Z]/.test(name)) && prev === CLexer.LeftBracket && type(i + 1) === CLexer.Identifier && type(i + 2) === CLexer.LeftParen) {
      hide(i, i);
      continue;
    }
    // `CLUB_DATA_FAST⏎CLUB_DATA_SLOWER⏎};` closing a struct body: names alone at the end stand for members.
    if (MACRO_NAME.test(name) && tagBody[i] === 1 && !called && (prev === CLexer.LeftBrace || prev === CLexer.Semi || prev === CLexer.RightBrace)) {
      let end = i;
      while (type(end + 1) === CLexer.Identifier && MACRO_NAME.test(tokens[end + 1]!.text ?? "") && type(end + 2) !== CLexer.LeftParen) end++;
      // `CLUB_HANDLE_FIELDS⏎CLUB_STREAM_FIELDS⏎int ipc;`: two or more before a member's type, which no declarator follows so.
      if (type(end + 1) === CLexer.RightBrace || (end > i && SPECIFIER_KEYWORDS.has(type(end + 1)))) {
        hide(i, end);
        i = end;
        continue;
      }
    }
    // `CLUB_KIND_MAP(EMIT)⏎CLUB_LAST` in an enum body: a list macro, bare or called, standing where an enumerator
    // starts and followed by the next name with no comma. An enumerator is followed by `,`, `=` or `}`, or by an attribute macro
    // (`A CLUB_DEPRECATED(1) = 3,`, which has arguments or `=` after it).
    if (MACRO_NAME.test(name) && enumBody[i] === 1 && (prev === CLexer.LeftBrace || prev === CLexer.Comma || tokens[i - 1]?.channel === Token.HIDDEN_CHANNEL)
      && after === CLexer.Identifier && [CLexer.Comma, CLexer.RightBrace, CLexer.Identifier].includes(type((called ? close[i + 1]! : i) + 2))) {
      hide(i, called ? close[i + 1]! : i);
      continue;
    }
    if (MACRO_NAME.test(name) && stack.at(-1) === true && (prev === CLexer.LeftBrace || prev === CLexer.Comma || prev === CLexer.RightBrace)
      && (after === CLexer.Identifier || after === CLexer.LeftBrace || after === CLexer.Dot)) {
      // `{ A, B }` lists constants; a name right before the next entry, with no comma, is no entry.
      hide(i, called ? close[i + 1]! : i);
      continue;
    }
    // `T * __attribute__ ((always_inline)) league_internal⏎f(`: after an attribute that follows a whole type, a name
    // before the declared one takes only attributes — a macro (`static __attribute__ ((unused)) club_t f(` is a type).
    if (prev === CLexer.RightParen && type(i + 1) === CLexer.Identifier && type(i + 2) === CLexer.LeftParen && closesAttribute(i - 1)
      && completeTypeBefore((opened.get(i - 1) ?? 0) - 1)) {
      hide(i, i);
      continue;
    }
    // `(unsigned CLUB_INT_T)x`: a macro after a type keyword inside a cast stands for the rest of its type, which
    // the keyword names well enough — a parameter list (`f(unsigned N)`) declares a name there, a call's `(` too.
    if (MACRO_NAME.test(name) && BEFORE_MACRO_KEYWORDS.has(prev) && type(i + 1) === CLexer.RightParen
      && (type(i + 2) === CLexer.Identifier || type(i + 2) === CLexer.IntegerConstant || type(i + 2) === CLexer.FloatingConstant)) {
      let from = i - 1;
      while (BEFORE_MACRO_KEYWORDS.has(type(from)) || type(from) === CLexer.Star) from--;
      if (type(from) === CLexer.LeftParen && type(from - 1) !== CLexer.Identifier && !BEFORE_MACRO_KEYWORDS.has(type(from - 1))) hide(i, i);
      continue;
    }
    // `NAME (T) 0`: a macro, a parenthesized type and an operand — a call has no operand after it.
    if (MACRO_NAME.test(name) && called && (prev === CLexer.Assign || prev === CLexer.Comma || prev === CLexer.LeftParen || prev === CLexer.Return)
      && (after === CLexer.IntegerConstant || after === CLexer.FloatingConstant || after === CLexer.CharacterConstant || after === CLexer.Identifier)) {
      const end = close[i + 1]!;
      let typeOnly = end > i + 2;
      for (let k = i + 2; k < end && typeOnly; k++) typeOnly = type(k) === CLexer.Identifier || type(k) === CLexer.Star || BEFORE_MACRO_KEYWORDS.has(type(k));
      if (typeOnly) hide(i, i);
    }
  }
  // `};⏎CLUB_DATA_SLOW⏎CLUB_DATA_FAST⏎` ending a file: names alone with nothing after them, whatever a use in a struct
  // made the first pass take them for, are macros.
  let end = n - 1;
  while (end >= 0 && type(end) === CLexer.Identifier && MACRO_NAME.test(tokens[end]!.text ?? "") && type(end - 1) !== CLexer.Dot && type(end - 1) !== CLexer.Arrow) end--;
  if (end < n - 1 && end >= 0 && (type(end) === CLexer.Semi || type(end) === CLexer.RightBrace)) hide(end + 1, n - 1);
}

export function readTypes(stream: CommonTokenStream): CTokenFacts {
  stream.fill();
  const all = stream.getTokens();
  hideMacros(all);
  const tokens = all.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.type !== Token.EOF);
  const names: Array<string | undefined> = tokens.map((t) => (t.type === CLexer.Identifier ? t.text ?? "" : undefined));
  const types = new Set(STANDARD);
  const singles = new Set<string>();
  for (const t of all) {
    if (t.type !== CLexer.Directive && t.type !== CLexer.MultiLineMacro) continue;
    const m = SINGLE_DEFINE.exec(t.text ?? "");
    if (m) singles.add(m[1]!);
  }
  const isMacro = (name: string) => MACRO_NAME.test(name) || singles.has(name);
  const type = (i: number) => tokens[i]?.type ?? -1;
  const isId = (i: number) => type(i) === CLexer.Identifier;
  const macroName = (i: number) => isId(i) && isMacro(names[i]!);
  const tag = (i: number) => TAG_KEYWORDS.has(type(i - 1));
  /** A declaration may start at `i`: after a statement or parameter boundary, or a leading keyword. */
  const boundary = (i: number) => {
    if (i === 0) return true;
    const p = type(i - 1);
    return p === CLexer.LeftParen || p === CLexer.Comma || p === CLexer.LeftBrace || p === CLexer.RightBrace || p === CLexer.Semi || LEADING_KEYWORDS.has(p);
  };
  /** The token at `i` is a type keyword, a name or `*`: what a function's return type ends in. */
  const typeish = (i: number) => isId(i) || BEFORE_MACRO_KEYWORDS.has(type(i)) || type(i) === CLexer.Star;
  const tagBody = tagBodies(tokens);
  // `cols_t[i].width = 1;`: a name indexed and then read for a member is a variable, whatever its suffix says; no type
  // is followed by an index and a member access.
  const indexedMembers = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isId(i) || !names[i]!.endsWith("_t") || type(i + 1) !== CLexer.LeftBracket || type(i - 1) === CLexer.Dot || type(i - 1) === CLexer.Arrow) continue;
    let k = i + 1;
    while (type(k) === CLexer.LeftBracket) {
      for (let depth = 0; k < tokens.length; k++) {
        if (type(k) === CLexer.LeftBracket) depth++;
        else if (type(k) === CLexer.RightBracket && --depth === 0) break;
        else if (type(k) === CLexer.Semi) break;
      }
      k++;
    }
    if (type(k) === CLexer.Dot || type(k) === CLexer.Arrow) indexedMembers.add(names[i]!);
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!isId(i) || tag(i)) continue;
    const name = names[i]!;
    if (name.endsWith("_t") && !indexedMembers.has(name)) types.add(name);
    const prev = type(i - 1);
    if (prev === CLexer.Dot || prev === CLexer.Arrow) continue;
    // A specifier macro: `leagueAtomic int n;`, `TARGET_POPCNT static int f(`.
    if (boundary(i) && BEFORE_MACRO_KEYWORDS.has(type(i + 1))) types.add(name);
    // `static UINT __stdcall start(`: a name before a calling-convention keyword is the return type.
    if ((boundary(i) || BEFORE_MACRO_KEYWORDS.has(prev)) && CALLING_KEYWORDS.has(type(i + 1)) && isId(i + 2)) types.add(name);
    // `ILEpointer __attribute__((aligned(16))) slot;`: a name before an attribute and a declared name is the type.
    if (boundary(i) && type(i + 1) === CLexer.Attribute && type(i + 2) === CLexer.LeftParen) {
      let j = i + 2;
      for (let depth = 0; j < tokens.length; j++) {
        if (type(j) === CLexer.LeftParen) depth++;
        else if (type(j) === CLexer.RightParen && --depth === 0) break;
      }
      if (isId(j + 1) && AFTER_NAME.has(type(j + 2))) types.add(name);
    }
    // `CLUB_ALIGN(8) club_u64 acc[8];`: a name after an all-caps macro's call that starts a declaration, before the
    // declared name, is its type — no expression has a name after a call's `)`.
    if (prev === CLexer.RightParen && isId(i + 1) && AFTER_NAME.has(type(i + 2))) {
      let open = i - 2;
      for (let depth = 1; open >= 0 && depth > 0; open--) {
        if (type(open) === CLexer.RightParen) depth++;
        else if (type(open) === CLexer.LeftParen) depth--;
      }
      // `open` now sits one before the `(`: the macro's name.
      if (isId(open) && MACRO_NAME.test(names[open]!) && boundary(open)) types.add(name);
    }
    // A run of names ending in a declared one: all but the last are types — after a type keyword or `*` too.
    let star = i - 1;
    while (type(star) === CLexer.Star) star--;
    const afterType = BEFORE_MACRO_KEYWORDS.has(prev) || (star < i - 1 && (isId(star) || BEFORE_MACRO_KEYWORDS.has(type(star))));
    if (isId(i + 1) && (boundary(i) || afterType || (isId(i - 1) && !tag(i - 1)))) {
      let j = i + 1;
      while (isId(j + 1)) j++;
      const after = type(j + 1);
      // The declared name is the run's last but trailing attribute macros: `int fd UNUSED)`.
      let declared = j;
      // An all-caps name before `[` is the array declared: `uShort TABLE[1024]`.
      // So is a `__` name after `*name`: `void *key __stored_key,`.
      const pointer = prev === CLexer.Star;
      if (after !== CLexer.LeftBracket) while (declared > i && (macroName(declared) || (pointer && names[declared]!.startsWith("__")))) declared--;
      // `WINBASEAPI BOOL WINAPI f(`: a name after a type of the run is one too, but the one before the declared name stands for a calling convention.
      // `CLUB_A CLUB_B⏎club_t⏎CLUB_JOIN(a, b)⏎(params) {`: the declared name is a called macro, so the run ends in the type
      // before it (`declared` stops on it): a name after a type of the run is a specifier of that type too.
      const inRun = isId(i - 1) && types.has(names[i - 1]!)
        && (declared > i + 1 || (declared === i + 1 && j > declared && after === CLexer.LeftParen && (names[declared]!.endsWith("_t") || types.has(names[declared]!))));
      if (declared > i && (AFTER_NAME.has(after) || CALLING_KEYWORDS.has(after) || (after === CLexer.LeftParen && (boundary(i) || afterType || inRun)) || after === CLexer.Star)) types.add(name);
    }
    // `CLUB_TYPE CLUB_FIELD(score);` in a struct: no member function exists in C, so the name before a call that
    // ends the member is its type.
    if (boundary(i) && tagBody[i] === 1 && isId(i + 1) && type(i + 2) === CLexer.LeftParen && isId(i + 3) && type(i + 4) === CLexer.RightParen
      && (type(i + 5) === CLexer.Semi || type(i + 5) === CLexer.Colon)) types.add(name);
    // `HRESULT (WINAPI *pfn)(…);`: a name before a function pointer's declarator is its return type.
    let qualified = i + 3;
    while (QUALIFIER_KEYWORDS.has(type(qualified + 1))) qualified++;
    if (boundary(i) && type(i + 1) === CLexer.LeftParen && isId(i + 2) && type(i + 3) === CLexer.Star && isId(qualified + 1) && type(qualified + 2) === CLexer.RightParen && type(qualified + 3) === CLexer.LeftParen) {
      types.add(name);
      // Its parameters are bare type names: `(HANDLE, PWSTR*)`.
      let from = qualified + 4;
      for (let j = qualified + 4; j < tokens.length && type(j) !== CLexer.RightParen; j++) {
        if (type(j) !== CLexer.Comma) continue;
        if (isId(from) && (j === from + 1 || type(from + 1) === CLexer.Star)) types.add(names[from]!);
        from = j + 1;
      }
      if (isId(from) && (type(from + 1) === CLexer.RightParen || type(from + 1) === CLexer.Star)) types.add(names[from]!);
    }
    // `club *c,` / `(car_wash_t* req)` / `leagueDb *db =` / `GarageType *garageType(` at a declaration's start.
    if (type(i + 1) === CLexer.Star && boundary(i)) {
      let j = i + 1;
      while (type(j) === CLexer.Star || QUALIFIER_KEYWORDS.has(type(j))) j++;
      const after = type(j + 1);
      // `f(a * b)` multiplies inside a call; `void f(club *c)` declares, its name after a return type.
      const call = prev === CLexer.LeftParen && isId(i - 2) && !typeish(i - 3);
      if (isId(j) && (AFTER_NAME.has(after) || after === CLexer.LeftParen) && !call) types.add(name);
      // `club_pts *CLUB_RESTRICT points,`: a macro qualifying the pointer stands before the declared name.
      if (isId(j) && macroName(j) && isId(j + 1) && AFTER_NAME.has(type(j + 2)) && !call) types.add(name);
      // `(garage_loop_t*)` / `(const BYTE *)` / `(const char *, int)`: an abstract declarator.
      let open = i - 1;
      while (QUALIFIER_KEYWORDS.has(type(open))) open--;
      if ((type(open) === CLexer.LeftParen || type(open) === CLexer.Comma) && (type(j) === CLexer.RightParen || type(j) === CLexer.Comma)) types.add(name);
    }
    // `(Spec[]){ … }`: an array compound literal — not `switch (dirs[i]) {`, nor a call's argument.
    const opener = type(i - 2);
    if (prev === CLexer.LeftParen && type(i + 1) === CLexer.LeftBracket && opener !== CLexer.Identifier && opener !== CLexer.RightParen && !NOT_BEFORE_CAST.has(opener)) {
      let j = i + 2;
      while (j < tokens.length && type(j) !== CLexer.RightBracket && type(j) !== CLexer.Semi) j++;
      if (type(j + 1) === CLexer.RightParen && type(j + 2) === CLexer.LeftBrace) types.add(name);
    }
    // `(foo) bar` after an operator or `return`, `(GarageMem) { … }`: a cast or a compound literal.
    const before = type(i - 2);
    if (prev === CLexer.LeftParen && type(i + 1) === CLexer.RightParen && OPERAND.has(type(i + 2)) && before !== -1
      && before !== CLexer.Identifier && before !== CLexer.RightParen && before !== CLexer.RightBracket && !NOT_BEFORE_CAST.has(before)
      && !(before === CLexer.LeftParen && type(i - 3) === CLexer.Attribute)) types.add(name);
  }
  // `typedef … name;` / `typedef … (*name)(…);` — the name each typedef declares.
  for (let i = 0; i < tokens.length; i++) {
    if (!TYPEDEF.has(type(i))) continue;
    let depth = 0;
    for (let j = i + 1; j < tokens.length; j++) {
      const t = type(j);
      if (t === CLexer.LeftBrace || t === CLexer.LeftParen) depth++;
      else if (t === CLexer.RightBrace || t === CLexer.RightParen) depth--;
      else if (t === CLexer.Semi && depth <= 0) break;
      if (t !== CLexer.Identifier) continue;
      const next = type(j + 1);
      if (depth === 0 && (next === CLexer.Semi || next === CLexer.Comma || next === CLexer.LeftBracket)) types.add(names[j]!);
      // `(*name)`, not a parameter's `char **argv)`.
      let star = j - 1;
      while (type(star) === CLexer.Star) star--;
      if (depth === 1 && star < j - 1 && type(star) === CLexer.LeftParen && next === CLexer.RightParen) types.add(names[j]!);
    }
  }
  return facts(all, tokens, names, types, isMacro);
}

function facts(all: Token[], tokens: Token[], names: Array<string | undefined>, types: Set<string>, isMacro: (name: string) => boolean): CTokenFacts {
  const size = all.length;
  const known = new Uint8Array(size);
  const macro = new Uint8Array(size);
  const close = new Int32Array(size).fill(-1);
  const blockArg = new Uint8Array(size);
  const stringMacro = new Uint8Array(size);
  const next = new Int32Array(size).fill(-1);
  const open: number[] = [];
  // The braces around each token, by position in `tokens`.
  const braces = new Int32Array(tokens.length);
  let level = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.RightBrace) level = Math.max(0, level - 1);
    braces[i] = level;
    if (t.type === CLexer.LeftBrace) level++;
  });
  // The parentheses around each token.
  const parens = new Int32Array(tokens.length);
  let nesting = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.RightParen) nesting = Math.max(0, nesting - 1);
    parens[i] = nesting;
    if (t.type === CLexer.LeftParen) nesting++;
  });
  let following = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    next[tokens[i]!.tokenIndex] = following;
    following = tokens[i]!.tokenIndex;
  }
  tokens.forEach((t, i) => {
    const name = names[i];
    if (name !== undefined) {
      if (types.has(name)) known[t.tokenIndex] = 1;
      if (isMacro(name)) macro[t.tokenIndex] = 1;
      // `HANDLE FileHandle`: two names in a row inside a call are a declaration, no expression.
      if (open.length > 0 && tokens[i - 1]?.type === CLexer.Identifier) blockArg[open.at(-1)!] = 1;
    } else if (t.type === CLexer.LeftParen) open.push(t.tokenIndex);
    else if (t.type === CLexer.RightParen) {
      const o = open.pop();
      if (o !== undefined) close[o] = t.tokenIndex;
    } else if ((t.type === CLexer.LeftBrace || t.type === CLexer.Semi) && open.length > 0) blockArg[open.at(-1)!] = 1;
    else if (BINARY_ONLY.has(t.type) && open.length > 0) {
      // An operator with no operand beside it: after `(` or `,`, before `,` or `)`.
      const before = tokens[i - 1]?.type;
      const after = tokens[i + 1]?.type;
      if (before === CLexer.LeftParen || before === CLexer.Comma || after === CLexer.RightParen || after === CLexer.Comma) blockArg[open.at(-1)!] = 1;
    }
  });
  // Names beside string literals, followed through runs of them: `"Server: " VERSION CRLF`, `QUOTE("x") " y"`.
  const ends = (i: number) => (tokens[i + 1]?.type === CLexer.LeftParen && close[tokens[i + 1]!.tokenIndex]! >= 0 ? indexOf(close[tokens[i + 1]!.tokenIndex]!) : i);
  const indexOf = (tokenIndex: number) => position.get(tokenIndex) ?? -1;
  const position = new Map(tokens.map((t, i) => [t.tokenIndex, i]));
  const opens = new Map<number, number>();
  close.forEach((c, o) => c >= 0 && opens.set(c, o));
  // Lowercase names only a macro can be, by where they stand: `ql_elm(T) link;` where a declaration starts (a call
  // followed by a name is no C), `x[] attribute_hidden;` after a declarator, `*key __stored_key)`.
  tokens.forEach((t, i) => {
    const name = names[i];
    if (name === undefined || macro[t.tokenIndex]) return;
    const prev = tokens[i - 1]?.type ?? CLexer.Semi;
    // `int f(int n) internal_function;` at file scope: after a prototype's parameters no type stands, whatever the
    // first pass took the name for where it stands between a definition's return type and name.
    if (prev === CLexer.RightParen && braces[i] === 0 && (tokens[i + 1]?.type === CLexer.Semi || tokens[i + 1]?.type === CLexer.Comma)) {
      const open = indexOf(opens.get(tokens[i - 1]!.tokenIndex) ?? -1);
      const before = tokens[open - 2];
      if (open > 1 && tokens[open - 1]!.type === CLexer.Identifier && before && (before.type === CLexer.Star || before.type === CLexer.Identifier || BEFORE_MACRO_KEYWORDS.has(before.type))) macro[t.tokenIndex] = 1;
      return;
    }
    if (types.has(name)) return;
    const next = tokens[i + 1]?.type;
    if (next === CLexer.LeftParen && DECLARATION_BOUNDARY.has(prev)) {
      const after = indexOf(close[tokens[i + 1]!.tokenIndex]!) + 1;
      if (after > 0 && tokens[after]?.type === CLexer.Identifier && DECLARATOR_END.has(tokens[after + 1]?.type ?? -1)) macro[t.tokenIndex] = 1;
    } else if (next !== undefined && DECLARATOR_END.has(next) && (prev === CLexer.RightBracket || (prev === CLexer.Identifier && tokens[i - 2]?.type === CLexer.Star))) macro[t.tokenIndex] = 1;
  });
  const tagBody = tagBodies(tokens);
  const isString = (i: number) => tokens[i]?.type === CLexer.StringLiteral;
  /** The name a `)` at `i` closes the arguments of, or -1. */
  const calledBy = (i: number) => {
    const o = tokens[i]?.type === CLexer.RightParen ? opens.get(tokens[i]!.tokenIndex) : undefined;
    return o === undefined ? -1 : indexOf(o) - 1;
  };
  // Two all-caps names in a row where an operand stands can only be string macros joined: `ANSI_PREFIX DISPLAY_PREFIX;`,
  // `f(a, SEP SEP, b)`.
  const macroAt = (i: number) => names[i] !== undefined && isMacro(names[i]!) && !types.has(names[i]!);
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (!macroAt(i) || macroAt(i - 1)) continue;
    let end = i;
    while (macroAt(end + 1)) end++;
    if (end === i) continue;
    const before = tokens[i - 1]?.type;
    const after = tokens[end + 1]?.type;
    if ((before === CLexer.Assign || before === CLexer.Comma || before === CLexer.LeftParen) && (after === CLexer.Semi || after === CLexer.Comma || after === CLexer.RightParen)) {
      for (let k = i; k <= end; k++) stringMacro[tokens[k]!.tokenIndex] = 1;
    }
    i = end;
  }
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < tokens.length; i++) {
      if (names[i] === undefined || stringMacro[tokens[i]!.tokenIndex] === 1) continue;
      const end = ends(i);
      const prev = tokens[i - 1];
      const after = end + 1;
      const caller = calledBy(i - 1);
      const joined =
        isString(i - 1) || (prev?.type === CLexer.Identifier && stringMacro[prev.tokenIndex] === 1) ||
        (caller >= 0 && names[caller] !== undefined && stringMacro[tokens[caller]!.tokenIndex] === 1) ||
        isString(after) || (names[after] !== undefined && stringMacro[tokens[after]!.tokenIndex] === 1);
      if (joined) stringMacro[tokens[i]!.tokenIndex] = 1;
    }
  }
  // What the grammar reads by token: a macro alone where a statement or declaration starts, before what only starts
  // another (`PARSER_BEGIN`, `END_DECLS int x;`); a calling convention (`BOOL WINAPI start(`, `* api_cdecl f(`,
  // `(WINAPI *pfn)(…)`); a macro joined to strings.
  const retype = new Int32Array(size);
  const typeOf = (i: number) => tokens[i]?.type ?? -1;
  const isName = (i: number) => names[i] !== undefined;
  /** The `{` at `i` opens a block, not an initializer: after `else`/`do`, or the `)` of a call or an `if (…)`. */
  const blockBrace = (i: number) => {
    const before = typeOf(i - 1);
    if (BLOCK_KEYWORDS.has(before)) return true;
    if (before !== CLexer.RightParen) return false;
    const open = opens.get(tokens[i - 1]!.tokenIndex);
    const head = open === undefined ? -1 : typeOf(position.get(open)! - 1);
    return head === CLexer.Identifier || BLOCK_HEAD_KEYWORDS.has(head);
  };
  /** The token at `i` is the first inside a struct, union or enum body: `enum tag {`. */
  const startsTagBody = (i: number) => typeOf(i - 1) === CLexer.LeftBrace && (TAG_KEYWORDS.has(typeOf(i - 2)) || (isName(i - 2) && TAG_KEYWORDS.has(typeOf(i - 3))));
  /** Qualifiers between a `*` and the name it points to (`*const fn`), counted from `i`. */
  const qualifiersAfter = (i: number) => {
    let n = 0;
    while (QUALIFIER_KEYWORDS.has(typeOf(i + n))) n++;
    return n;
  };
  const caps = (i: number) => isName(i) && isMacro(names[i]!) && !types.has(names[i]!);
  /** An all-caps name, even one the first pass took for a type elsewhere (`M⏎int f(` and `N M⏎int g(`). */
  const macroNamed = (i: number) => isName(i) && isMacro(names[i]!);
  /** The `}` at `i` ends a struct, union or enum body: `} name(…) {` then defines a function returning it. */
  const closesTag = (i: number) => {
    let level = 0;
    for (let j = i; j >= 0; j--) {
      if (typeOf(j) === CLexer.RightBrace) level++;
      else if (typeOf(j) === CLexer.LeftBrace && --level === 0) return TAG_KEYWORDS.has(typeOf(j - 1)) || (isName(j - 1) && TAG_KEYWORDS.has(typeOf(j - 2)));
    }
    return false;
  };
  // `MATCH_TEST(kickoff) {` at file scope: a name, its arguments and a body — a macro defining a function. Read as a
  // definition without specifiers it would make prediction read the whole body to choose.
  let depth = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.LeftBrace) depth++;
    else if (t.type === CLexer.RightBrace) depth = Math.max(0, depth - 1);
    if (depth !== 0 || !isName(i) || types.has(names[i]!) || (i > 0 && typeOf(i - 1) !== CLexer.Semi && typeOf(i - 1) !== CLexer.RightBrace)) return;
    const open = tokens[i + 1];
    if (open?.type !== CLexer.LeftParen || close[open.tokenIndex]! < 0) return;
    if (typeOf(position.get(close[open.tokenIndex]!)! + 1) === CLexer.LeftBrace && !(typeOf(i - 1) === CLexer.RightBrace && closesTag(i - 1))) retype[t.tokenIndex] = CLexer.MacroName;
  });
  // `YY_DECL {`: a macro naming a function's whole header.
  depth = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.LeftBrace) depth++;
    else if (t.type === CLexer.RightBrace) depth = Math.max(0, depth - 1);
    if (depth === 0 && isName(i) && isMacro(names[i]!) && typeOf(i + 1) === CLexer.LeftBrace && (i === 0 || typeOf(i - 1) === CLexer.Semi || typeOf(i - 1) === CLexer.RightBrace)) {
      retype[t.tokenIndex] = CLexer.MacroName;
    }
  });
  // `c->w = 3;`, `col[1].w = 10;`: a name followed by a member access, through any index groups. No declarator reads
  // so, so a name before it is a macro statement of its own.
  const writesMember = (j: number): boolean => {
    let k = j + 1;
    while (typeOf(k) === CLexer.LeftBracket) {
      let depthBracket = 0;
      for (; k < tokens.length; k++) {
        if (typeOf(k) === CLexer.LeftBracket) depthBracket++;
        else if (typeOf(k) === CLexer.RightBracket && --depthBracket === 0) break;
        else if (typeOf(k) === CLexer.Semi) return false;
      }
      k++;
    }
    return typeOf(k) === CLexer.Dot || typeOf(k) === CLexer.Arrow;
  };
  tokens.forEach((t, i) => {
    if (!isName(i) || retype[t.tokenIndex] !== 0) return;
    const k = t.tokenIndex;
    if (stringMacro[k] === 1) {
      retype[k] = CLexer.StringMacro;
      return;
    }
    const prev = typeOf(i - 1);
    const next = typeOf(i + 1);
    // A bare macro may also follow another: `END_DECLS PUSH_DIAGNOSTICS`. Before `}` or a statement keyword no type
    // stands, whatever the first pass took the name for.
    // The same name read before a keyword elsewhere (`M⏎int f(`) is a type to the first pass, yet `M N⏎int g(` is two macros.
    // Longer runs too (`M N P⏎int h(`): the names after the first all caps (a type to the first pass or not), then a specifier keyword.
    let runEnd = i + 1;
    while (macroNamed(runEnd)) runEnd++;
    const beforeMacroRun = isName(i) && isMacro(names[i]!) && runEnd > i + 1 && SPECIFIER_KEYWORDS.has(typeOf(runEnd));
    // And `M N(a, b)⏎M2` at file scope: a macro call run, whose name M a use before `static` made a type to the first
    // pass (longer runs too: `M N P(a)`, the run being the names between M and the call's `(`).
    const callOpen2 = tokens[runEnd];
    const beforeMacroCall = braces[i] === 0 && isName(i) && isMacro(names[i]!) && runEnd > i + 1 && callOpen2?.type === CLexer.LeftParen && close[callOpen2.tokenIndex]! >= 0
      && (() => {
        const after = position.get(close[callOpen2.tokenIndex]!)! + 1;
        return after >= tokens.length || SPECIFIER_KEYWORDS.has(typeOf(after)) || macroNamed(after);
      })();
    const capsHere = caps(i) || (isName(i) && isMacro(names[i]!) && (next === CLexer.RightBrace || STATEMENT_KEYWORDS.has(next) || beforeMacroRun || beforeMacroCall));
    // `TEST_BEGIN⏎ check(x);`, `TEST_BEGIN⏎ Garage *g;` in a body: before a call or a declaration it opens nothing,
    // whatever the first pass took it for there.
    if (isName(i) && isMacro(names[i]!) && !(tagBody[i] === 1 && types.has(names[i]!)) && braces[i]! > 0 && BARE_AFTER.has(prev) && !startsTagBody(i) && isName(i + 1) && (typeOf(i + 2) === CLexer.LeftParen || (types.has(names[i + 1]!) && typeOf(i + 2) === CLexer.Star) || writesMember(i + 1))) {
      retype[k] = CLexer.MacroName;
      return;
    }
    // At file scope after a macro's arguments, a list's `LIST_START⏎ENTRY (a)⏎LIST_END`: a name alone, then more macros or the end.
    const callOpen = prev === CLexer.RightParen ? opens.get(tokens[i - 1]!.tokenIndex) : undefined;
    const callAt = callOpen === undefined ? -1 : position.get(callOpen)! - 1;
    const afterCall = callAt >= 0 && isName(callAt) && (callAt === 0 || [CLexer.Semi, CLexer.RightBrace, CLexer.RightParen].includes(typeOf(callAt - 1))
      || (retype[tokens[callAt - 1]!.tokenIndex] === CLexer.MacroName && braces[i] === 0));
    // A run of macro calls then a name alone before the next declaration (`KICKOFF⏎FN(a, b)⏎FN(c, d)⏎FULLTIME⏎int f(`).
    const endsFile = afterCall && braces[i] === 0 && (i + 1 === tokens.length || (macroNamed(i + 1) && typeOf(i + 2) !== CLexer.Semi) || SPECIFIER_KEYWORDS.has(next));
    if (capsHere && (i === 0 || BARE_AFTER.has(prev) || endsFile || retype[tokens[i - 1]!.tokenIndex] === CLexer.MacroName)) {
      // Before `}` only after a statement or a block's `{`: `TEST_END }` closes a body, `= { NULL }` initializes.
      const bare = STATEMENT_KEYWORDS.has(next) || SPECIFIER_KEYWORDS.has(next) || next === CLexer.LeftBrace || i + 1 === tokens.length
        || (next === CLexer.RightBrace && (prev === CLexer.Semi || prev === CLexer.RightBrace || (prev === CLexer.LeftBrace && blockBrace(i - 1))))
        || (next === CLexer.Star && [CLexer.PlusPlus, CLexer.MinusMinus, CLexer.LeftParen].includes(typeOf(i + 2)))
        || (macroNamed(i + 1) && typeOf(i + 2) !== CLexer.Semi && !startsTagBody(i));
      if (bare) {
        retype[k] = CLexer.MacroName;
        return;
      }
    }
    // After `*` a name before a declarator's name and its `(` is no type, whatever the first pass took it for.
    const declaratorNext = isName(i + 1) && typeOf(i + 2) === CLexer.LeftParen;
    // `slot_t * MUTABLE slot = …`: an all-caps macro after `*` before the declared name qualifies it.
    if ((prev === CLexer.Star || prev === CLexer.Caret) && (declaratorNext || (isMacro(names[i]!) && isName(i + 1)))) retype[k] = CLexer.CallingConvention;
    // `, FAR *LPFOO;` in a file-scope declarator list: a convention before the `*`, where a declarator stands.
    else if (prev === CLexer.Comma && next === CLexer.Star && braces[i] === 0 && parens[i] === 0 && isMacro(names[i]!) && isName(i + 2)) retype[k] = CLexer.CallingConvention;
    // `TYPE_ATTR(bool) TLS_MODEL x = …`: a second macro before the declared name qualifies it.
    else if (prev === CLexer.RightParen && braces[i] === 0 && isMacro(names[i]!) && isName(i + 1) && AFTER_NAME.has(typeOf(i + 2)) && !types.has(names[i]!)) retype[k] = CLexer.CallingConvention;
    // `size_t token_pos SILENCE_INIT(0)`: a lowercase name before an all-caps one is the declared name, the other a macro.
    else if (!types.has(names[i]!) && declaratorNext && isName(i - 1) && types.has(names[i - 1]!) && !(isMacro(names[i + 1]!) && !isMacro(names[i]!))) retype[k] = CLexer.CallingConvention;
    // `int (WINAPI *fn)(…)`: after a return type, whatever the first pass took the name for.
    else if ((!types.has(names[i]!) || isName(i - 2) || BEFORE_MACRO_KEYWORDS.has(typeOf(i - 2)) || typeOf(i - 2) === CLexer.Star) && prev === CLexer.LeftParen && (next === CLexer.Star || next === CLexer.Caret) && isName(i + 2 + qualifiersAfter(i + 2)) && typeOf(i + 3 + qualifiersAfter(i + 2)) === CLexer.RightParen) {
      const open = tokens[i - 1]!.tokenIndex;
      const after = close[open]! >= 0 ? position.get(close[open]!)! + 1 : -1;
      if (typeOf(after) === CLexer.LeftParen) retype[k] = CLexer.CallingConvention;
    }
  });
  // A `:` right before a `}` ends a label (`default:⏎}`): nothing else can precede a closing brace so.
  tokens.forEach((t, i) => {
    // A bare macro after it (`case 1:⏎YY_RULE_SETUP`) is a block item of its own, no statement of the label.
    if (t.type === CLexer.Colon && (typeOf(i + 1) === CLexer.RightBrace || (i + 1 < tokens.length && retype[tokens[i + 1]!.tokenIndex] === CLexer.MacroName))) retype[t.tokenIndex] = CLexer.LabelColon;
  });
  return { types, known, macro, close, blockArg, stringMacro, retype, next };
}
