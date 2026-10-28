/*
 * The first of the C reading's two passes: the names a file uses as types, which the parser's predicates
 * (CParserBase.ts) read as typedef names. A compiler learns them from the headers `gcc -E` pulls in; an analyzer
 * without the build's include paths learns them from how the file itself uses them. The pass also answers, once
 * per token, what the predicates would otherwise recompute at every prediction.
 */
import { Token, type CommonTokenStream } from "antlr4ng";
import { CLexer } from "./CLexer.js";
import { STATEMENT_KEYWORDS, SPECIFIER_KEYWORDS, BEFORE_MACRO_KEYWORDS, LEADING_KEYWORDS, NOT_BEFORE_CAST, QUALIFIER_KEYWORDS, TAG_KEYWORDS, TYPEDEF } from "./CKeywords.js";

/** Types every C program sees through the standard headers. */
const STANDARD = ["FILE", "DIR", "va_list", "jmp_buf", "sigjmp_buf", "bool", "wchar_t", "fd_set", "sigset_t", "locale_t"];

/** Where a bare macro may start a statement or declaration. */
const BARE_AFTER: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.LeftBrace, CLexer.RightBrace, CLexer.Colon]);

/** An all-caps macro name: `UNUSED`, `NO_CHECKS`, `PRINTF_LIKE`. */
/** Where a declaration starts, for a macro standing for its type. */
const DECLARATION_BOUNDARY: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.LeftBrace, CLexer.RightBrace, ...TYPEDEF, ...LEADING_KEYWORDS]);

/** What ends a declarator. */
const DECLARATOR_END: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.Comma, CLexer.LeftBracket, CLexer.Assign, CLexer.RightParen]);

export const MACRO_NAME = /^[A-Z_][A-Z0-9_]*[A-Z][A-Z0-9_]*$/;

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
export function readTypes(stream: CommonTokenStream): CTokenFacts {
  stream.fill();
  const all = stream.getTokens();
  const tokens = all.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.type !== Token.EOF);
  const names: Array<string | undefined> = tokens.map((t) => (t.type === CLexer.Identifier ? t.text ?? "" : undefined));
  const types = new Set(STANDARD);
  const type = (i: number) => tokens[i]?.type ?? -1;
  const isId = (i: number) => type(i) === CLexer.Identifier;
  const macroName = (i: number) => isId(i) && MACRO_NAME.test(names[i]!);
  const tag = (i: number) => TAG_KEYWORDS.has(type(i - 1));
  /** A declaration may start at `i`: after a statement or parameter boundary, or a leading keyword. */
  const boundary = (i: number) => {
    if (i === 0) return true;
    const p = type(i - 1);
    return p === CLexer.LeftParen || p === CLexer.Comma || p === CLexer.LeftBrace || p === CLexer.RightBrace || p === CLexer.Semi || LEADING_KEYWORDS.has(p);
  };
  /** The token at `i` is a type keyword, a name or `*`: what a function's return type ends in. */
  const typeish = (i: number) => isId(i) || BEFORE_MACRO_KEYWORDS.has(type(i)) || type(i) === CLexer.Star;
  for (let i = 0; i < tokens.length; i++) {
    if (!isId(i) || tag(i)) continue;
    const name = names[i]!;
    if (name.endsWith("_t")) types.add(name);
    const prev = type(i - 1);
    if (prev === CLexer.Dot || prev === CLexer.Arrow) continue;
    // A specifier macro: `leagueAtomic int n;`, `TARGET_POPCNT static int f(`.
    if (boundary(i) && BEFORE_MACRO_KEYWORDS.has(type(i + 1))) types.add(name);
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
      if (declared > i && (AFTER_NAME.has(after) || (after === CLexer.LeftParen && (boundary(i) || afterType)) || after === CLexer.Star)) types.add(name);
    }
    // `club *c,` / `(car_wash_t* req)` / `leagueDb *db =` / `GarageType *garageType(` at a declaration's start.
    if (type(i + 1) === CLexer.Star && boundary(i)) {
      let j = i + 1;
      while (type(j) === CLexer.Star || QUALIFIER_KEYWORDS.has(type(j))) j++;
      const after = type(j + 1);
      // `f(a * b)` multiplies inside a call; `void f(club *c)` declares, its name after a return type.
      const call = prev === CLexer.LeftParen && isId(i - 2) && !typeish(i - 3);
      if (isId(j) && (AFTER_NAME.has(after) || after === CLexer.LeftParen) && !call) types.add(name);
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
      && before !== CLexer.Identifier && before !== CLexer.RightParen && before !== CLexer.RightBracket && !NOT_BEFORE_CAST.has(before)) types.add(name);
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
  return facts(all, tokens, names, types);
}

function facts(all: Token[], tokens: Token[], names: Array<string | undefined>, types: Set<string>): CTokenFacts {
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
  let following = -1;
  for (let i = tokens.length - 1; i >= 0; i--) {
    next[tokens[i]!.tokenIndex] = following;
    following = tokens[i]!.tokenIndex;
  }
  tokens.forEach((t, i) => {
    const name = names[i];
    if (name !== undefined) {
      if (types.has(name)) known[t.tokenIndex] = 1;
      if (MACRO_NAME.test(name)) macro[t.tokenIndex] = 1;
    } else if (t.type === CLexer.LeftParen) open.push(t.tokenIndex);
    else if (t.type === CLexer.RightParen) {
      const o = open.pop();
      if (o !== undefined) close[o] = t.tokenIndex;
    } else if ((t.type === CLexer.LeftBrace || t.type === CLexer.Semi) && open.length > 0) blockArg[open.at(-1)!] = 1;
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
  const isString = (i: number) => tokens[i]?.type === CLexer.StringLiteral;
  /** The name a `)` at `i` closes the arguments of, or -1. */
  const calledBy = (i: number) => {
    const o = tokens[i]?.type === CLexer.RightParen ? opens.get(tokens[i]!.tokenIndex) : undefined;
    return o === undefined ? -1 : indexOf(o) - 1;
  };
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
  const caps = (i: number) => isName(i) && MACRO_NAME.test(names[i]!) && !types.has(names[i]!);
  // `MATCH_TEST(kickoff) {` at file scope: a name, its arguments and a body — a macro defining a function. Read as a
  // definition without specifiers it would make prediction read the whole body to choose.
  let depth = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.LeftBrace) depth++;
    else if (t.type === CLexer.RightBrace) depth = Math.max(0, depth - 1);
    if (depth !== 0 || !isName(i) || types.has(names[i]!) || (i > 0 && typeOf(i - 1) !== CLexer.Semi && typeOf(i - 1) !== CLexer.RightBrace)) return;
    const open = tokens[i + 1];
    if (open?.type !== CLexer.LeftParen || close[open.tokenIndex]! < 0) return;
    if (typeOf(position.get(close[open.tokenIndex]!)! + 1) === CLexer.LeftBrace) retype[t.tokenIndex] = CLexer.MacroName;
  });
  // `YY_DECL {`: a macro naming a function's whole header.
  depth = 0;
  tokens.forEach((t, i) => {
    if (t.type === CLexer.LeftBrace) depth++;
    else if (t.type === CLexer.RightBrace) depth = Math.max(0, depth - 1);
    if (depth === 0 && isName(i) && MACRO_NAME.test(names[i]!) && typeOf(i + 1) === CLexer.LeftBrace && (i === 0 || typeOf(i - 1) === CLexer.Semi || typeOf(i - 1) === CLexer.RightBrace)) {
      retype[t.tokenIndex] = CLexer.MacroName;
    }
  });
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
    const capsHere = caps(i) || (isName(i) && MACRO_NAME.test(names[i]!) && (next === CLexer.RightBrace || STATEMENT_KEYWORDS.has(next)));
    // `TEST_BEGIN⏎ check(x);`, `TEST_BEGIN⏎ Garage *g;` in a body: before a call or a declaration it opens nothing,
    // whatever the first pass took it for there.
    if (isName(i) && MACRO_NAME.test(names[i]!) && braces[i]! > 0 && BARE_AFTER.has(prev) && isName(i + 1) && (typeOf(i + 2) === CLexer.LeftParen || (types.has(names[i + 1]!) && typeOf(i + 2) === CLexer.Star))) {
      retype[k] = CLexer.MacroName;
      return;
    }
    if (capsHere && (i === 0 || BARE_AFTER.has(prev) || retype[tokens[i - 1]!.tokenIndex] === CLexer.MacroName)) {
      // Before `}` only after a statement: `TEST_END }` closes a body, `{ NULL }` initializes.
      const bare = STATEMENT_KEYWORDS.has(next) || SPECIFIER_KEYWORDS.has(next) || next === CLexer.LeftBrace || i + 1 === tokens.length
        || (next === CLexer.RightBrace && (prev === CLexer.Semi || prev === CLexer.RightBrace))
        || (next === CLexer.Star && [CLexer.PlusPlus, CLexer.MinusMinus, CLexer.LeftParen].includes(typeOf(i + 2)))
        || (caps(i + 1) && typeOf(i + 2) !== CLexer.Semi);
      if (bare) {
        retype[k] = CLexer.MacroName;
        return;
      }
    }
    // After `*` a name before a declarator's name and its `(` is no type, whatever the first pass took it for.
    const declaratorNext = isName(i + 1) && typeOf(i + 2) === CLexer.LeftParen;
    // `slot_t * MUTABLE slot = …`: an all-caps macro after `*` before the declared name qualifies it.
    if ((prev === CLexer.Star || prev === CLexer.Caret) && (declaratorNext || (MACRO_NAME.test(names[i]!) && isName(i + 1)))) retype[k] = CLexer.CallingConvention;
    // `size_t token_pos SILENCE_INIT(0)`: a lowercase name before an all-caps one is the declared name, the other a macro.
    else if (!types.has(names[i]!) && declaratorNext && isName(i - 1) && types.has(names[i - 1]!) && !(MACRO_NAME.test(names[i + 1]!) && !MACRO_NAME.test(names[i]!))) retype[k] = CLexer.CallingConvention;
    // `int (WINAPI *fn)(…)`: after a return type, whatever the first pass took the name for.
    else if ((!types.has(names[i]!) || isName(i - 2) || BEFORE_MACRO_KEYWORDS.has(typeOf(i - 2))) && prev === CLexer.LeftParen && (next === CLexer.Star || next === CLexer.Caret) && isName(i + 2) && typeOf(i + 3) === CLexer.RightParen) {
      const open = tokens[i - 1]!.tokenIndex;
      const after = close[open]! >= 0 ? position.get(close[open]!)! + 1 : -1;
      if (typeOf(after) === CLexer.LeftParen) retype[k] = CLexer.CallingConvention;
    }
  });
  return { types, known, macro, close, blockArg, stringMacro, retype, next };
}
