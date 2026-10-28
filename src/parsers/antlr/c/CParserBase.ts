/*
 * The parser predicates of grammars-v4's C grammar (c/Antlr4ng/CParserBase.ts, BSD licence — see
 * grammars/antlr/c/CParser.g4), rewritten to read tokens only. Upstream resolved a name to a type through a symbol
 * table the parse filled as it went — per-file state a shared prediction cache cannot see — and needed `gcc -E` to
 * know the types headers declare. Here a name is a type when the file's first pass says so (CTypes.ts: `prepare`
 * runs it, fixed for the whole parse), and what a predicate asks of a token — a known type, a macro name, the `)`
 * closing a `(` — is answered once per token by that pass.
 */
import { Parser, Token, type CommonTokenStream, type TokenStream } from "antlr4ng";
import { CLexer } from "./CLexer.js";
import { QUALIFIER_KEYWORDS, SPECIFIER_KEYWORDS, STATEMENT_KEYWORDS, STATIC_ASSERT, TYPE_KEYWORDS } from "./CKeywords.js";
import { readTypes, type CTokenFacts } from "./CTypes.js";

/** What may follow a declarator's name: an identifier here is the name, not a type. */
const AFTER_DECLARATOR: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.Comma, CLexer.Assign, CLexer.RightParen, CLexer.LeftBracket, CLexer.Colon]);

/** What ends a declarator: `;`, `,`, `=`, `{`, `)`. */
const END_OF_DECLARATOR: ReadonlySet<number> = new Set([CLexer.Semi, CLexer.Comma, CLexer.Assign, CLexer.LeftBrace, CLexer.RightParen]);

const NO_FACTS: CTokenFacts = {
  types: new Set(),
  known: new Uint8Array(0),
  macro: new Uint8Array(0),
  close: new Int32Array(0),
  blockArg: new Uint8Array(0),
  stringMacro: new Uint8Array(0),
  retype: new Int32Array(0),
  next: new Int32Array(0),
};

export abstract class CParserBase extends Parser {
  private facts: CTokenFacts = NO_FACTS;

  constructor(input: TokenStream) {
    super(input);
  }

  /** The first pass over the tokens the parse is about to read. */
  prepare(stream: CommonTokenStream): void {
    this.facts = readTypes(stream);
    // The names the first pass read as bare macros, calling conventions and string macros, retyped for the grammar.
    this.facts.retype.forEach((type, index) => {
      if (type > 0) (stream.get(index) as { type: number }).type = type;
    });
    stream.seek(0);
  }

  /** The names the first pass read as types. */
  get types(): ReadonlySet<string> {
    return this.facts.types;
  }

  private lt(k: number): Token {
    return this.inputStream.LT(k)!;
  }

  private known(t: Token): boolean {
    return t.type === CLexer.Identifier && this.facts.known[t.tokenIndex] === 1;
  }

  private macroName(t: Token): boolean {
    return (t.type === CLexer.Identifier || t.type === CLexer.MacroName) && this.facts.macro[t.tokenIndex] === 1;
  }

  /** A type token: a type keyword, or a known type name. */
  private isType(t: Token): boolean {
    return TYPE_KEYWORDS.has(t.type) || this.known(t);
  }

  /** The token after the `)` closing the `(` token `open`, or null. */
  private afterClosing(open: Token): Token | null {
    if (open.type !== CLexer.LeftParen) return null;
    const close = this.facts.close[open.tokenIndex] ?? -1;
    return close < 0 ? null : this.following(this.inputStream.get(close));
  }

  /**
   * The identifier at `k` names a type: a known name where a type can stand — followed by a name, `*`, `(*`, `)`,
   * `,`, `[` or a specifier, never by `=`, `->` or `++` (`len = …` uses a variable the file also casts to) — and not
   * the name a type before it declares (`foo_t foo_t;`).
   */
  private typedefAt(k: number): boolean {
    if (!this.known(this.lt(k))) return false;
    const next = this.lt(k + 1);
    const follows = next.type === CLexer.Identifier || next.type === CLexer.CallingConvention || next.type === CLexer.Star || next.type === CLexer.RightParen
      || next.type === CLexer.Comma || next.type === CLexer.LeftBracket || SPECIFIER_KEYWORDS.has(next.type)
      || (next.type === CLexer.LeftParen && (this.lt(k + 2).type === CLexer.Star || this.lt(k + 2).type === CLexer.Caret));
    if (!follows) return false;
    const prev = this.lt(k === 1 ? -1 : k - 1);
    // After a type, or a struct body's `}` (`typedef struct x { … } Club, *ClubPtr;`), a name before `,` `;` `=` is declared.
    if (!prev || !(this.isType(prev) || prev.type === CLexer.RightBrace)) return true;
    // `club_inline club_int_t foo(`: a known type followed by a name or `*` is no declarator either.
    return !AFTER_DECLARATOR.has(next.type);
  }

  /** An attribute macro at `k` among a declaration's specifiers: `NO_CHECKS("alignment")` followed by more of it. */
  private macroAttributeAt(k: number): boolean {
    if (!this.macroName(this.lt(k))) return false;
    const next = this.afterClosing(this.lt(k + 1));
    return !!next && (SPECIFIER_KEYWORDS.has(next.type) || next.type === CLexer.Identifier || next.type === CLexer.Star);
  }

  /** Declaration specifiers start at `k`. */
  private specifierAt(k: number): boolean {
    return SPECIFIER_KEYWORDS.has(this.lt(k).type) || this.typedefAt(k) || this.macroAttributeAt(k);
  }

  /**
   * A declaration in a body starts at 1: a macro attribute only before a type (`ALIGNED(8) int x;`), since
   * `IGNORE_DEPRECATION(…) set(x, y);` is a statement macro before a call, not a declaration of `set`.
   */
  private declarationAt(): boolean {
    if (SPECIFIER_KEYWORDS.has(this.lt(1).type) || this.typedefAt(1)) return true;
    if (!this.macroAttributeAt(1)) return false;
    let next = this.afterClosing(this.lt(2));
    while (next && this.macroName(next)) {
      const open = this.following(next);
      if (open?.type !== CLexer.LeftParen) break;
      next = this.afterClosing(open);
    }
    return !!next && (SPECIFIER_KEYWORDS.has(next.type) || this.known(next));
  }

  /** The token after `t` on the default channel, or null. */
  private following(t: Token): Token | null {
    const next = this.facts.next[t.tokenIndex] ?? -1;
    return next < 0 ? null : this.inputStream.get(next);
  }

  /** A type name starts at `k`, inside parentheses: a type keyword, a qualifier, or a known name where a type can stand. */
  private typeNameAt(k: number): boolean {
    return SPECIFIER_KEYWORDS.has(this.lt(k).type) || this.typedefAt(k);
  }

  /** A macro invocation `name(…)` at 1 that is no known type, and what follows its `)`. */
  private macroCall(): Token | null {
    const name = this.lt(1);
    if (name.type !== CLexer.Identifier || this.known(name)) return null;
    return this.afterClosing(this.lt(2));
  }

  protected IsTypedefName(): boolean {
    return this.typedefAt(1);
  }
  protected IsDeclarationSpecifier(): boolean {
    return this.specifierAt(1) || this.lt(1).type === CLexer.CallingConvention;
  }
  protected IsTypeSpecifierQualifier(): boolean {
    return this.specifierAt(1);
  }
  protected IsDeclaration(): boolean {
    // `name:` is a label.
    return (this.declarationAt() && this.lt(2).type !== CLexer.Colon) || STATIC_ASSERT.has(this.lt(1).type);
  }
  protected IsStatement(): boolean {
    return !this.IsDeclaration();
  }
  protected IsCast(): boolean {
    return this.lt(1).type === CLexer.LeftParen && this.typeNameAt(2);
  }
  protected IsSomethingOfTypeName(): boolean {
    return this.lt(2).type === CLexer.LeftParen && this.typeNameAt(3);
  }
  protected IsInitDeclaratorList(): boolean {
    return this.lt(1).type !== CLexer.Semi;
  }
  protected IsNullStructDeclarationListExtension(): boolean {
    return this.lt(1).type === CLexer.RightBrace;
  }
  protected IsVaArg(): boolean {
    return this.lt(1).type === CLexer.Identifier && this.lt(2).type === CLexer.LeftParen && this.lt(1).text === "va_arg";
  }
  protected IsMacroAttribute(): boolean {
    return this.macroAttributeAt(1);
  }
  /** An attribute macro after a declarator, bare (`int fd UNUSED`) or called, ending it or followed by another. */
  protected IsMacroAttributeSuffix(): boolean {
    if (!this.macroName(this.lt(1))) return false;
    const next = this.lt(2).type === CLexer.LeftParen ? this.afterClosing(this.lt(2)) : this.lt(2);
    return !!next && (END_OF_DECLARATOR.has(next.type) || this.macroName(next));
  }
  /** A macro invoked at file scope as a statement: `name(…);`. */
  /** A macro invoked at file scope: `name(…);`, or an all-caps one before what only starts a declaration, or the end. */
  protected IsTopLevelMacro(): boolean {
    const name = this.lt(1);
    if (name.type !== CLexer.Identifier || this.known(name) || this.lt(2).type !== CLexer.LeftParen) return false;
    // `DEFINE_WATCHER(idle, IDLE)`, `gen_heap(0)` as the file's last line: no definition ends a file so.
    if ((this.facts.close[this.lt(2).tokenIndex] ?? -1) >= 0 && !this.afterClosing(this.lt(2))) return true;
    const next = this.macroCall();
    if (!next) return false;
    if (next.type === CLexer.Semi) return true;
    if (this.macroName(this.lt(1)) && (next.type === Token.EOF || SPECIFIER_KEYWORDS.has(next.type) || this.macroName(next))) return true;
    // `heap_gen(…)⏎weak_alias (a, b)⏎int f(…)`: more invocations, then the file's end or a declaration — a K&R
    // definition's parameters (`f(a) int a; {`) reach its body's `{` before any `(`.
    let after: Token | null = next;
    for (let more = 0; after && more < 8 && after.type === CLexer.Identifier && !this.known(after); more++) {
      const open = this.following(after);
      if (open?.type !== CLexer.LeftParen || (this.facts.close[open.tokenIndex] ?? -1) < 0) break;
      after = this.afterClosing(open);
    }
    if (!after) return true;
    return (SPECIFIER_KEYWORDS.has(after.type) || this.known(after)) && this.declarationFollows(after);
  }

  /** From `t`, a `(` comes before a `{`, or the file ends. */
  private declarationFollows(t: Token): boolean {
    let at: Token | null = t;
    for (let steps = 0; at && steps < 256; steps++, at = this.following(at)) {
      if (at.type === CLexer.LeftParen) return true;
      if (at.type === CLexer.LeftBrace) return false;
    }
    return at === null;
  }

  /** A `;` ends the macro at 1 and its arguments: the form with `;` applies, else the one without. */
  protected SemiAfterMacro(): boolean {
    return this.afterClosing(this.lt(2))?.type === CLexer.Semi;
  }








  /** After a string literal, a name can only be a macro the strings concatenate with: `"%" PRIu64`. */

  /** A name directly before a string literal is a macro it concatenates with: `close_gate_n " failed"`. */

  /** A macro's argument that is a type: `struct squad_item`, `unsigned int`, a known type before `*`, `,` or `)`. */
  protected IsTypeArgument(): boolean {
    // `const char *`: qualifiers first.
    let k = 1;
    while (QUALIFIER_KEYWORDS.has(this.lt(k).type)) k++;
    const t = this.lt(k);
    if (TYPE_KEYWORDS.has(t.type)) return true;
    if (!this.known(t)) return false;
    const next = this.lt(k + 1).type;
    return next === CLexer.Star || next === CLexer.Comma || next === CLexer.RightParen;
  }
  /** A name alone as a struct member, not a type the file knows: a macro expanding to members, `CommonHeader;`. */
  protected IsBareMacroMember(): boolean {
    return this.lt(1).type === CLexer.Identifier && this.lt(2).type === CLexer.Semi && !this.known(this.lt(1));
  }
  /** An all-caps name alone before the struct's `}`: `COMPAT_END }`. */
  protected IsLastMacroMember(): boolean {
    return this.macroName(this.lt(1)) && this.lt(2).type === CLexer.RightBrace;
  }
  /** A macro as a struct member: `BIT(can_substitute);`. */
  protected IsMacroMember(): boolean {
    const next = this.macroCall();
    // `COMPAT_BEGIN(5) COMPAT_END }`: another macro after it.
    return !!next && (next.type === CLexer.Semi || next.type === CLexer.RightBrace || (this.macroName(this.lt(1)) && this.macroName(next)));
  }
  /** A statement macro holding a declaration or a block: `VERBOSE(size_t calls = 0);`, `EACH(x, { … });`. */
  protected IsMacroStatement(): boolean {
    const third = this.lt(3);
    const holds = SPECIFIER_KEYWORDS.has(third.type) || (this.known(third) && (this.lt(4).type === CLexer.Identifier || this.lt(4).type === CLexer.Star))
      || this.facts.blockArg[this.lt(2).tokenIndex] === 1;
    const after = this.macroCall();
    if (!after) return false;
    // `TYPE_MAP(XX)` before `default:` or `}`, another macro: no `;` follows it.
    if (this.macroName(this.lt(1)) && (after.type === CLexer.RightBrace || after.type === CLexer.Case || after.type === CLexer.Default || (this.macroName(after) && this.following(after)?.type === CLexer.LeftParen))) return true;
    return holds && after.type === CLexer.Semi;
  }
  /** A statement macro: `name(…)` followed by a statement's start rather than `;` or an operator. */
  protected IsMacroBlock(): boolean {
    const name = this.lt(1);
    if (name.type !== CLexer.Identifier || this.lt(2).type !== CLexer.LeftParen) return false;
    const next = this.afterClosing(this.lt(2));
    // A name right after `)` cannot continue an expression: it starts the macro's body (`for_each_item(i, l)⏎ use(i);`)
    // — unless it is the next statement macro (`FRAME(1)⏎FRAME(2)`), or each would nest the rest of the block.
    if (next && this.macroName(name) && this.macroName(next) && this.following(next)?.type === CLexer.LeftParen) return false;
    return !!next && (next.type === CLexer.LeftBrace || next.type === CLexer.Identifier || STATEMENT_KEYWORDS.has(next.type));
  }
  protected EnterDeclaration(): void {}
  protected EnterScope(): void {}
  protected ExitScope(): void {}
  protected LookupSymbol(): void {}
  protected OutputSymbolTable(): void {}
}
