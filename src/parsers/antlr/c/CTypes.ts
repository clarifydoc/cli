/*
 * The first of the C reading's two passes: the names a file uses as types, which the parser's predicates
 * (CParserBase.ts) read as typedef names. A compiler learns them from the headers `gcc -E` pulls in; an analyzer
 * without the build's include paths learns them from how the file itself uses them. The pass also answers, once
 * per token, what the predicates would otherwise recompute at every prediction.
 */
import { Token, type CommonTokenStream } from "antlr4ng";
import { CLexer } from "./CLexer.js";
import { BEFORE_MACRO_KEYWORDS, LEADING_KEYWORDS, NOT_BEFORE_CAST, QUALIFIER_KEYWORDS, TAG_KEYWORDS, TYPEDEF } from "./CKeywords.js";

/** Types every C program sees through the standard headers. */
const STANDARD = ["FILE", "DIR", "va_list", "jmp_buf", "sigjmp_buf", "bool", "wchar_t", "fd_set", "sigset_t", "locale_t"];

/** An all-caps macro name: `UNUSED`, `NO_CHECKS`, `PRINTF_LIKE`. */
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
      while (declared > i && macroName(declared)) declared--;
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
      if (depth === 1 && type(j - 1) === CLexer.Star && next === CLexer.RightParen) types.add(names[j]!);
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
  const next = new Int32Array(size).fill(-1);
  const open: number[] = [];
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
  return { types, known, macro, close, blockArg, next };
}
