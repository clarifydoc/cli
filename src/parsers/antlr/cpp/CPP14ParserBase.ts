/*
 * The parser predicates of grammars-v4's C++ grammar (cpp/TypeScript/CPP14ParserBase.ts, MIT licence — see
 * grammars/antlr/cpp/CPP14Parser.g4), rewritten to read tokens only, and the predicates the grammar's [ClarifyDoc]
 * changes added: where C++ cannot be read without knowing which names are types and templates, they read what the
 * file's first pass (CppTypes.ts, `prepare`) says of each token, fixed for the whole parse.
 */
import { Parser, RuleTransition, Token, type ATN, type ATNState, type CommonTokenStream, type ParserRuleContext, type TokenStream } from "antlr4ng";
import { CPP14Lexer } from "./CPP14Lexer.js";
import { CLASS_KEYWORDS, SPECIFIER_KEYWORDS, TYPE_KEYWORDS, readTypes, type CppTokenFacts } from "./CppTypes.js";

/** What may stand right before a pure specifier `= 0`: a function declarator's `)` and what follows it. */
const BEFORE_PURE: ReadonlySet<number> = new Set([CPP14Lexer.RightParen, CPP14Lexer.Const, CPP14Lexer.Override, CPP14Lexer.Final, CPP14Lexer.Noexcept, CPP14Lexer.Volatile]);

/** Keywords a declaration statement starts with. */
const DECLARATION_KEYWORDS: ReadonlySet<number> = new Set([
  ...TYPE_KEYWORDS, ...SPECIFIER_KEYWORDS, ...CLASS_KEYWORDS, CPP14Lexer.Using, CPP14Lexer.Static_assert,
  CPP14Lexer.Namespace, CPP14Lexer.Template, CPP14Lexer.Asm, CPP14Lexer.Alignas,
]);

/** After a type name: what starts its declarator, or another specifier. */
const DECLARATOR_START: ReadonlySet<number> = new Set([
  CPP14Lexer.Identifier, CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.AndAnd, CPP14Lexer.Ellipsis, CPP14Lexer.Operator,
  ...SPECIFIER_KEYWORDS, ...TYPE_KEYWORDS,
]);

/** After a type in a parameter or template argument with no declarator: `f(Club, int)`, `f(Club = {})`. */
const ABSTRACT_END: ReadonlySet<number> = new Set([CPP14Lexer.Comma, CPP14Lexer.RightParen, CPP14Lexer.TemplateGreater]);

/** After a parameter list, what only a function declarator has: a body, qualifiers, a trailing return type. */
const AFTER_PARAMETERS: ReadonlySet<number> = new Set([
  CPP14Lexer.LeftBrace, CPP14Lexer.Colon, CPP14Lexer.Const, CPP14Lexer.Volatile, CPP14Lexer.Override, CPP14Lexer.Final,
  CPP14Lexer.Noexcept, CPP14Lexer.Arrow, CPP14Lexer.Assign, CPP14Lexer.And, CPP14Lexer.AndAnd, CPP14Lexer.Throw,
  CPP14Lexer.Try,
]);



/** What may follow a macro after a declarator. */
const MACRO_SUFFIX_END: ReadonlySet<number> = new Set([
  CPP14Lexer.Semi, CPP14Lexer.Comma, CPP14Lexer.Assign, CPP14Lexer.LeftBrace, CPP14Lexer.RightParen, CPP14Lexer.Colon,
  CPP14Lexer.Override, CPP14Lexer.Final, CPP14Lexer.Const, CPP14Lexer.Noexcept, CPP14Lexer.Arrow, CPP14Lexer.Try,
]);

/** Keywords a statement starts with: what may follow a statement macro. */
const STATEMENT_KEYWORDS: ReadonlySet<number> = new Set([
  CPP14Lexer.If, CPP14Lexer.For, CPP14Lexer.While, CPP14Lexer.Do, CPP14Lexer.Switch, CPP14Lexer.Return,
  CPP14Lexer.Break, CPP14Lexer.Continue, CPP14Lexer.Goto, CPP14Lexer.Case, CPP14Lexer.Default, CPP14Lexer.Try,
  CPP14Lexer.Throw, CPP14Lexer.Co_return,
]);

const POINTER_OPERATORS: ReadonlySet<number> = new Set([CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.AndAnd, CPP14Lexer.Caret]);

const ACCESS: ReadonlySet<number> = new Set([CPP14Lexer.Public, CPP14Lexer.Private, CPP14Lexer.Protected]);

/** Qt's section keywords, macros the file does not expand. */
const QT_SECTIONS: ReadonlySet<string> = new Set(["signals", "slots", "Q_SIGNALS", "Q_SLOTS"]);

const isName = (type: number) => type === CPP14Lexer.Identifier || type === CPP14Lexer.MacroName;

/** Keywords that start only a simple declaration or a function definition at namespace scope. */
const DECLARATION_START: ReadonlySet<number> = new Set([
  CPP14Lexer.Const, CPP14Lexer.Volatile, CPP14Lexer.Static, CPP14Lexer.Thread_local, CPP14Lexer.Register,
  CPP14Lexer.Mutable, CPP14Lexer.Virtual, CPP14Lexer.Explicit, CPP14Lexer.Friend, CPP14Lexer.Constexpr,
  CPP14Lexer.Typedef, CPP14Lexer.Typename_, CPP14Lexer.Class, CPP14Lexer.Struct, CPP14Lexer.Union,
]);

/** The same in a class body, where `inline`, `extern` and `enum` start nothing else. */
const MEMBER_START: ReadonlySet<number> = new Set([...DECLARATION_START, CPP14Lexer.Inline, CPP14Lexer.Extern, CPP14Lexer.Enum]);

interface StatementAlts {
  macro: number;
  macroBlock: number;
  label: number;
  declaration: number;
  expression: number;
}

interface DeclarationAlts {
  module: number;
  macroFunction: number;
  topLevelMacro: number;
  simple: number;
}

interface MemberAlts {
  macro: number;
  member: number;
}

/** The simulators whose decisions are settled already. */
const settled = new WeakSet<object>();

/** The alternative of `decision` whose start reaches `rule` before a token: which alternative a sub-rule is. */
function altReaching(atn: ATN, decision: number, rule: number): number {
  const state = atn.decisionToState[decision]!;
  for (let i = 0; i < state.transitions.length; i++) {
    const seen = new Set<number>();
    const queue: ATNState[] = [state.transitions[i]!.target];
    while (queue.length > 0) {
      const s = queue.pop()!;
      if (seen.has(s.stateNumber)) continue;
      seen.add(s.stateNumber);
      for (const t of s.transitions) {
        if (t instanceof RuleTransition) {
          if (t.ruleIndex === rule) return i + 1;
        } else if (t.isEpsilon) queue.push(t.target);
      }
    }
  }
  return 0;
}

/** The decision of `rule` whose alternatives reach every one of `rules`. */
function decisionOf(atn: ATN, rule: number, rules: number[]): number {
  for (let d = 0; d < atn.decisionToState.length; d++) {
    if (atn.decisionToState[d]!.ruleIndex === rule && rules.every((r) => altReaching(atn, d, r) > 0)) return d;
  }
  throw new Error(`C++ grammar: no decision of rule ${rule} reaches rules ${rules.join(", ")}`);
}

let table: Map<number, (parser: CPP14ParserBase) => number> | null = null;

/** The settled decisions, found in the ATN by the rules their alternatives start, so a grammar change cannot misnumber them. */
function dispatch(atn: ATN, ruleNames: readonly string[]): Map<number, (parser: CPP14ParserBase) => number> {
  if (table) return table;
  // The parser's rule numbers, without importing the parser (which extends this class).
  const rule = (name: string) => {
    const index = ruleNames.indexOf(name);
    if (index < 0) throw new Error(`C++ grammar: no rule ${name}`);
    return index;
  };
  const [statement, macroStatement, macroBlockStatement, labeledStatement, declarationStatement, expressionStatement] =
    ["statement", "macroStatement", "macroBlockStatement", "labeledStatement", "declarationStatement", "expressionStatement"].map(rule) as [number, number, number, number, number, number];
  const s = decisionOf(atn, statement, [macroStatement, declarationStatement, expressionStatement]);
  const statementAlts: StatementAlts = {
    macro: altReaching(atn, s, macroStatement),
    macroBlock: altReaching(atn, s, macroBlockStatement),
    label: altReaching(atn, s, labeledStatement),
    declaration: altReaching(atn, s, declarationStatement),
    expression: altReaching(atn, s, expressionStatement),
  };
  const [declaration, macroFunctionDefinition, topLevelMacro, declarationTail, moduleDeclaration] = ["declaration", "macroFunctionDefinition", "topLevelMacro", "declarationTail", "moduleDeclaration"].map(rule) as [number, number, number, number, number];
  const d = decisionOf(atn, declaration, [macroFunctionDefinition, topLevelMacro, declarationTail]);
  const declarationAlts: DeclarationAlts = {
    module: altReaching(atn, d, moduleDeclaration),
    macroFunction: altReaching(atn, d, macroFunctionDefinition),
    topLevelMacro: altReaching(atn, d, topLevelMacro),
    simple: altReaching(atn, d, declarationTail),
  };
  const [memberDeclaration, memberMacro, memberDeclaratorList] = ["memberDeclaration", "memberMacro", "memberDeclaratorList"].map(rule) as [number, number, number];
  const m = decisionOf(atn, memberDeclaration, [memberMacro, memberDeclaratorList]);
  const memberAlts: MemberAlts = { macro: altReaching(atn, m, memberMacro), member: altReaching(atn, m, memberDeclaratorList) };
  table = new Map([
    [s, (p) => p.settleStatement(statementAlts)],
    [d, (p) => p.settleDeclaration(declarationAlts)],
    [m, (p) => p.settleMember(memberAlts)],
  ]);
  return table;
}

const NO_FACTS: CppTokenFacts = {
  types: new Set(),
  known: new Uint8Array(0),
  macro: new Uint8Array(0),
  close: new Int32Array(0),
  angle: new Int32Array(0),
  cast: new Uint8Array(0),
  macroCall: new Uint8Array(0),
  fold: new Uint8Array(0),
  nonExpression: new Uint8Array(0),
  next: new Int32Array(0),
};

export abstract class CPP14ParserBase extends Parser {
  private facts: CppTokenFacts = NO_FACTS;

  constructor(input: TokenStream) {
    super(input);
  }

  /** Whether the first pass saw `name` used as a type. */
  isTypeName(name: string): boolean {
    return this.facts.types.has(name);
  }

  /** The first pass over the tokens the parse is about to read, and the decisions it settles. */
  prepare(stream: CommonTokenStream): void {
    this.facts = readTypes(stream);
    // The template brackets and cast parentheses the first pass found, retyped for the grammar.
    this.facts.angle.forEach((close, open) => {
      if (close < 0) return;
      (stream.get(open) as { type: number }).type = CPP14Lexer.TemplateLess;
      (stream.get(close) as { type: number }).type = CPP14Lexer.TemplateGreater;
    });
    this.facts.cast.forEach((cast, open) => {
      if (cast === 1) (stream.get(open) as { type: number }).type = CPP14Lexer.CastLeftParen;
    });
    this.facts.macroCall.forEach((call, name) => {
      if (call === 1) (stream.get(name) as { type: number }).type = CPP14Lexer.MacroName;
    });
    this.facts.fold.forEach((fold, open) => {
      if (fold === 1) (stream.get(open) as { type: number }).type = CPP14Lexer.FoldLeftParen;
    });
    stream.seek(0);
    const simulator = this.interpreter;
    if (settled.has(simulator)) return;
    settled.add(simulator);
    const table = dispatch(this.atn, this.ruleNames);
    const predict = simulator.adaptivePredict.bind(simulator);
    simulator.adaptivePredict = (input: TokenStream, decision: number, outer: ParserRuleContext | null): number => {
      const settle = table.get(decision);
      const alt = settle ? settle(this) : 0;
      return alt > 0 ? alt : predict(input, decision, outer);
    };
  }

  /**
   * The statement, declaration and member decisions, settled from tokens where they start with a name or a keyword
   * only one alternative takes. They are the grammar's widest: SLL prediction there simulates every way an
   * expression and a declaration can begin, which on a cold start is most of the parse's time. The predicates their
   * alternatives carry decide exactly these cases anyway; 0 leaves the decision to prediction.
   */
  settleStatement(alts: StatementAlts): number {
    const t = this.lt(1).type;
    if (t === CPP14Lexer.MacroName) return this.IsMacroBlock() ? alts.macroBlock : alts.macro;
    if (t !== CPP14Lexer.Identifier && t !== CPP14Lexer.Doublecolon) return 0;
    if (this.IsMacroStatement()) return alts.macro;
    if (this.IsMacroBlock()) return alts.macroBlock;
    if (t === CPP14Lexer.Identifier && this.lt(2).type === CPP14Lexer.Colon) return alts.label;
    return this.IsDeclarationStatement() ? alts.declaration : alts.expression;
  }

  settleDeclaration(alts: DeclarationAlts): number {
    const t = this.lt(1).type;
    if (t === CPP14Lexer.MacroName) return this.IsMacroFunction() ? alts.macroFunction : alts.topLevelMacro;
    if (t === CPP14Lexer.Identifier && (this.IsModuleKeyword() || this.IsImportKeyword())) return alts.module;
    if (t === CPP14Lexer.Identifier) {
      if (this.IsMacroFunction()) return alts.macroFunction;
      if (this.IsTopLevelMacro()) return alts.topLevelMacro;
      return alts.simple;
    }
    return t === CPP14Lexer.Doublecolon || TYPE_KEYWORDS.has(t) || DECLARATION_START.has(t) ? alts.simple : 0;
  }

  settleMember(alts: MemberAlts): number {
    const t = this.lt(1).type;
    if (t === CPP14Lexer.MacroName) return alts.macro;
    if (t === CPP14Lexer.Identifier) return this.IsMacroMember() ? alts.macro : alts.member;
    return t === CPP14Lexer.Doublecolon || t === CPP14Lexer.Tilde || t === CPP14Lexer.Operator || TYPE_KEYWORDS.has(t) || MEMBER_START.has(t) ? alts.member : 0;
  }

  /** The names the first pass read as types. */
  get types(): ReadonlySet<string> {
    return this.facts.types;
  }

  private lt(k: number): Token {
    return this.inputStream.LT(k)!;
  }

  private typeAt(index: number): number {
    return index < 0 ? -1 : this.inputStream.get(index).type;
  }

  private following(index: number): number {
    return index < 0 ? -1 : (this.facts.next[index] ?? -1);
  }

  /** The token after a qualified name starting at `index` (`::a::b<T>::c`), and the name's last part; null if none. */
  private pathAt(index: number): { last: number; after: number } | null {
    let i = index;
    if (this.typeAt(i) === CPP14Lexer.Doublecolon) i = this.following(i);
    if (this.typeAt(i) !== CPP14Lexer.Identifier) return null;
    let last = i;
    i = this.following(i);
    for (;;) {
      if ((this.facts.angle[i] ?? -1) >= 0) i = this.following(this.facts.angle[i]!);
      if (this.typeAt(i) !== CPP14Lexer.Doublecolon) return { last, after: i };
      let n = this.following(i);
      if (this.typeAt(n) === CPP14Lexer.Template) n = this.following(n);
      if (this.typeAt(n) !== CPP14Lexer.Identifier) return { last, after: i };
      last = n;
      i = this.following(n);
    }
  }

  /** A declarator in parentheses opens at `open`: `(*kick)`, `(&squad)`, `(Club::*kick)`, `(*squads[3])`. */
  private parenDeclaratorAt(open: number): boolean {
    let i = this.following(open);
    const path = this.pathAt(i);
    if (path && this.typeAt(path.after) === CPP14Lexer.Doublecolon && this.typeAt(this.following(path.after)) === CPP14Lexer.Star) i = this.following(path.after);
    if (!POINTER_OPERATORS.has(this.typeAt(i))) return false;
    while (POINTER_OPERATORS.has(this.typeAt(i)) || this.typeAt(i) === CPP14Lexer.Const) i = this.following(i);
    // `(*)`, `(*on_goal)`, `(*squads[3])` — never `(*load(id))`.
    if (this.typeAt(i) === CPP14Lexer.RightParen) return true;
    if (this.typeAt(i) !== CPP14Lexer.Identifier) return false;
    const next = this.typeAt(this.following(i));
    return next === CPP14Lexer.RightParen || next === CPP14Lexer.LeftBracket;
  }

  private known(index: number): boolean {
    return this.facts.known[index] === 1;
  }

  /** `= 0` after a function declarator: `virtual void kick() const = 0;`. */
  protected IsPureSpecifierAllowed(): boolean {
    return BEFORE_PURE.has(this.lt(-1)?.type ?? -1);
  }

  /**
   * A statement is a declaration: it starts with a keyword only a declaration starts with, or a (qualified, templated)
   * name followed by a name (`Club c;`, `std::vector<Club> squad;`), or by `*`/`&` and a declared name
   * (`Club *c = …`). A name followed by `(`, `=`, `.`, `->` or an operator is an expression.
   */
  protected IsDeclarationStatement(): boolean {
    let start = this.lt(1).tokenIndex;
    // `[[maybe_unused]] auto x = …`: what follows an attribute decides.
    while (this.typeAt(start) === CPP14Lexer.LeftBracket && this.typeAt(this.following(start)) === CPP14Lexer.LeftBracket) {
      const close = this.facts.close[start] ?? -1;
      if (close < 0) return false;
      start = this.following(close);
    }
    const type = this.typeAt(start);
    const second = this.following(start);
    // `void(0);`, `int{x};`: a type converting a value — but `void (*kick)(int);`, `void (Club::*kick)();` declare.
    if (TYPE_KEYWORDS.has(type) && type !== CPP14Lexer.Decltype && (this.typeAt(second) === CPP14Lexer.LeftBrace || (this.typeAt(second) === CPP14Lexer.LeftParen && !this.parenDeclaratorAt(second)))) return false;
    if (DECLARATION_KEYWORDS.has(type)) return true;
    if (type !== CPP14Lexer.Identifier && type !== CPP14Lexer.Doublecolon) return false;
    const path = this.pathAt(start);
    if (!path) return false;
    const after = this.typeAt(path.after);
    // `CONSTEXPR20 auto r = …`: a specifier macro before a declaration's keyword.
    if (this.macro(path.last) && path.last === start && DECLARATION_KEYWORDS.has(after)) return true;
    // `Club c`, `Club const &c`.
    if (after === CPP14Lexer.Identifier || after === CPP14Lexer.Const || after === CPP14Lexer.Volatile) return true;
    if (after === CPP14Lexer.Star || after === CPP14Lexer.And || after === CPP14Lexer.AndAnd) {
      let i = this.following(path.after);
      while ([CPP14Lexer.Star, CPP14Lexer.And, CPP14Lexer.Const].includes(this.typeAt(i))) i = this.following(i);
      if (this.typeAt(i) !== CPP14Lexer.Identifier) return false;
      return this.known(path.last) || [CPP14Lexer.Assign, CPP14Lexer.Semi, CPP14Lexer.Comma, CPP14Lexer.LeftParen, CPP14Lexer.LeftBracket, CPP14Lexer.LeftBrace].includes(this.typeAt(this.following(i)));
    }
    // `Callback (*on_goal)(int);`
    if (after === CPP14Lexer.LeftParen && this.known(path.last)) return this.parenDeclaratorAt(path.after);
    return false;
  }

  /**
   * A user name among declaration specifiers is a type: its declarator, another specifier, or (in a parameter) the
   * end of the parameter follows it. Before `(` it is the declarator itself — a constructor (`Club(int id);`,
   * `Club::Club()`) — and before `::~` a destructor's class.
   */
  protected IsDeclSpecifierType(): boolean {
    const t = this.lt(1);
    if (t.type === CPP14Lexer.MacroName) return false;
    if (t.type !== CPP14Lexer.Identifier && t.type !== CPP14Lexer.Doublecolon) return true;
    // `int goals`: a name after a type keyword is declared.
    if (TYPE_KEYWORDS.has(this.lt(-1)?.type ?? -1)) return false;
    const path = this.pathAt(t.tokenIndex);
    if (!path) return false;
    const after = this.typeAt(path.after);
    // `Club squad GUARDED_BY(mu);`: the macro ends the declarator the name is — after a type, not at a parameter's
    // start (`shared_ptr<Case> TEST_CTX)` names its parameter in capitals).
    const before = this.lt(-1)?.type ?? -1;
    if (after === CPP14Lexer.Identifier && before !== CPP14Lexer.LeftParen && before !== CPP14Lexer.Comma && this.macro(path.after) && MACRO_SUFFIX_END.has(this.typeAt(this.afterMacro(path.after)))) return false;
    if (DECLARATOR_START.has(after) || ABSTRACT_END.has(after)) return true;
    if (after === CPP14Lexer.Assign) return [CPP14Lexer.LeftParen, CPP14Lexer.Comma, CPP14Lexer.TemplateLess].includes(this.lt(-1)?.type ?? -1);
    // `Callback (*on_goal)(int)`, `int (Club::*member)`.
    if (after === CPP14Lexer.LeftParen) return this.parenDeclaratorAt(path.after);
    return false;
  }

  /**
   * `(` opens a parameter list rather than an initializer's arguments: empty, a type keyword or specifier, a name
   * followed by a declarator (`Club c`, `Club &`), or a bare name where the type is known or only a function
   * declarator can follow (`f(Club, Player) const {`). `Random rnd(Seed());` and `Club c(id, "x");` construct.
   */
  protected IsParameterList(): boolean {
    const open = this.lt(1);
    if (open.type !== CPP14Lexer.LeftParen) return false;
    const first = this.following(open.tokenIndex);
    const t = this.typeAt(first);
    if (t === CPP14Lexer.RightParen || t === CPP14Lexer.Ellipsis || TYPE_KEYWORDS.has(t) || SPECIFIER_KEYWORDS.has(t) || CLASS_KEYWORDS.has(t)) return true;
    // `main([[maybe_unused]] int argc)`: an attribute, which no argument starts with.
    if (t === CPP14Lexer.LeftBracket && this.typeAt(this.following(first)) === CPP14Lexer.LeftBracket) return true;
    const path = this.pathAt(first);
    if (!path) return false;
    const after = this.typeAt(path.after);
    if (DECLARATOR_START.has(after) || after === CPP14Lexer.Assign) return true;
    if (after !== CPP14Lexer.Comma && after !== CPP14Lexer.RightParen) return false;
    const close = this.facts.close[open.tokenIndex] ?? -1;
    // `void open(QString);`: a capitalized name, no macro's, is more likely a type than a variable.
    const name = this.inputStream.get(path.last).text ?? "";
    return this.known(path.last) || (/^[A-Z]/.test(name) && !this.macro(path.last)) || AFTER_PARAMETERS.has(this.typeAt(this.following(close)));
  }



  private macro(index: number): boolean {
    return this.facts.macro[index] === 1;
  }

  /** A macro's name at `index`, as `macroAt` reads a token. */
  private macroIndex(index: number): boolean {
    return index >= 0 && this.macroAt(this.inputStream.get(index));
  }

  /** A macro's name at `t`: an all-caps name, or one the first pass retyped for its arguments. */
  private macroAt(t: Token): boolean {
    return t.type === CPP14Lexer.MacroName || (t.type === CPP14Lexer.Identifier && this.macro(t.tokenIndex));
  }

  /** The token after a macro at `index` and its arguments, if any. */
  private afterMacro(index: number): number {
    const next = this.following(index);
    if (this.typeAt(next) !== CPP14Lexer.LeftParen) return next;
    const close = this.facts.close[next] ?? -1;
    return close < 0 ? -1 : this.following(close);
  }

  /**
   * `class EXPORT Club`, `__declspec(dllexport) void kick()`: a macro before a class's name or among specifiers,
   * with arguments or without, followed by a name or a keyword a declaration goes on with.
   */
  protected IsMacroSpecifier(withArguments: boolean): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t)) return false;
    if ((this.lt(2).type === CPP14Lexer.LeftParen) !== withArguments) return false;
    const after = this.typeAt(this.afterMacro(t.tokenIndex));
    // `EXPORT ~Club();`: a destructor's name.
    return after === CPP14Lexer.Identifier || DECLARATION_KEYWORDS.has(after) || after === CPP14Lexer.Tilde;
  }

  /** `(*)`, `(&)`, `(Club::*)` open a nested abstract declarator, not a parameter list. */
  protected IsAbstractParameterList(): boolean {
    if (this.lt(1).type !== CPP14Lexer.LeftParen) return false;
    const first = this.lt(2);
    if (first.type === CPP14Lexer.Star || first.type === CPP14Lexer.And || first.type === CPP14Lexer.AndAnd || first.type === CPP14Lexer.Caret) return false;
    const path = this.pathAt(first.tokenIndex);
    return !(path && this.typeAt(path.after) === CPP14Lexer.Doublecolon && this.typeAt(this.following(path.after)) === CPP14Lexer.Star);
  }

  /** A macro's arguments hold what no expression does: a type keyword, a block, a statement. */
  private holdsNonExpression(open: number): boolean {
    return this.facts.nonExpression[open] === 1;
  }

  /** `QFETCH(bool, ok);`, `Q_D(const Club);`, `CASE(X)` before another macro: a statement macro. */
  protected IsMacroStatement(): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t)) return false;
    // `QTEST_SET_PATH return run();`: a bare macro the first pass retyped, before a statement keyword or the block's end.
    if (this.lt(2).type !== CPP14Lexer.LeftParen) return t.type === CPP14Lexer.MacroName && this.lt(2).type !== CPP14Lexer.LeftBrace;
    const after = this.afterMacro(t.tokenIndex);
    const type = this.typeAt(after);
    if (t.type === CPP14Lexer.MacroName) return type !== CPP14Lexer.LeftBrace;
    if (type === CPP14Lexer.Semi) return this.holdsNonExpression(this.lt(2).tokenIndex);
    return type === CPP14Lexer.RightBrace || STATEMENT_KEYWORDS.has(type) || this.macroIndex(after);
  }

  /** `SECTION("x") {`, `Q_FOREACH(x, list) use(x);`: a macro before a statement it takes as its body. */
  protected IsMacroBlock(): boolean {
    const t = this.lt(1);
    // `BENCHMARK_LOOP { … }`: a bare macro the first pass retyped, before a block.
    if (t.type === CPP14Lexer.MacroName && this.lt(2).type === CPP14Lexer.LeftBrace) return true;
    if (!isName(t.type) || this.lt(2).type !== CPP14Lexer.LeftParen) return false;
    const after = this.afterMacro(t.tokenIndex);
    const type = this.typeAt(after);
    // A name after `)` cannot go on with an expression; a macro there is the next statement macro.
    return type === CPP14Lexer.LeftBrace || STATEMENT_KEYWORDS.has(type) || (type === CPP14Lexer.Identifier && !this.macro(after));
  }

  /** `TEST_MAIN(Squad)`, `REGISTER(int, 1);`, `BENCHMARK(kick)->Arg(1);`: a macro at file scope. */
  protected IsTopLevelMacro(): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t)) return false;
    // `BEGIN_NAMESPACE`, `END_NAMESPACE`: a bare macro before another declaration, a macro or the end.
    if (this.lt(2).type !== CPP14Lexer.LeftParen) return t.type === CPP14Lexer.MacroName;
    // At file scope no declaration starts with an all-caps name and its arguments: `INSTANTIATE_SUITE(Cup, …);`.
    return this.typeAt(this.afterMacro(t.tokenIndex)) !== CPP14Lexer.LeftBrace;
  }

  /**
   * A macro after a declarator, with arguments or without, ending it or followed by more of the declaration. Each form
   * is its own alternative so its `(` is never taken for a parameter list.
   */
  protected IsMacroSuffix(withArguments: boolean): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t)) return false;
    if ((this.lt(2).type === CPP14Lexer.LeftParen) !== withArguments) return false;
    const after = this.afterMacro(t.tokenIndex);
    return MACRO_SUFFIX_END.has(this.typeAt(after)) || this.macroIndex(after);
  }

  /**
   * `Q_OBJECT`, `ROUTE_ADD("/goals", Get)`, `DISABLE_COPY(Club)`: a macro as a class member, before another member, a
   * section or the end. Without arguments it must not be the type of a member (`HANDLE file;`).
   */
  protected IsMacroMember(): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t)) return false;
    const after = this.afterMacro(t.tokenIndex);
    const type = this.typeAt(after);
    if (type === CPP14Lexer.Semi || type === CPP14Lexer.RightBrace || ACCESS.has(type)) return true;
    if ((this.macroIndex(after) || type === CPP14Lexer.Identifier && QT_SECTIONS.has(this.inputStream.get(after).text ?? ""))) return true;
    if (this.lt(2).type !== CPP14Lexer.LeftParen) return false;
    return type === CPP14Lexer.Identifier || type === CPP14Lexer.Tilde || DECLARATION_KEYWORDS.has(type) || type === CPP14Lexer.Template;
  }

  /** A `;` ends the macro at 1, its arguments and any chain after them (`BENCH(f)->Arg(1);`). */
  protected SemiAfterMacro(): boolean {
    let after = this.afterMacro(this.lt(1).tokenIndex);
    while ((this.typeAt(after) === CPP14Lexer.Arrow || this.typeAt(after) === CPP14Lexer.Dot) && this.typeAt(this.following(this.following(after))) === CPP14Lexer.LeftParen) {
      after = this.afterMacro(this.following(after));
    }
    return this.typeAt(after) === CPP14Lexer.Semi;
  }

  /** `ENABLE_IF(cond)` among template parameters: a macro standing for one, before `,` or `>`. */
  protected IsMacroParameter(): boolean {
    const t = this.lt(1);
    if (!this.macroAt(t) || this.lt(2).type !== CPP14Lexer.LeftParen) return false;
    const after = this.typeAt(this.afterMacro(t.tokenIndex));
    return after === CPP14Lexer.Comma || after === CPP14Lexer.TemplateGreater;
  }

  /** `module league;`, `module;`, `export module league:stats;`: `module` as a keyword. */
  protected IsModuleKeyword(): boolean {
    const t = this.lt(1);
    const next = this.lt(2).type;
    return t.text === "module" && (next === CPP14Lexer.Identifier || next === CPP14Lexer.Semi || next === CPP14Lexer.Colon);
  }

  /** `import league;`, `import <vector>;`, `import "club.h";`, `import :stats;`: `import` as a keyword. */
  protected IsImportKeyword(): boolean {
    const t = this.lt(1);
    const next = this.lt(2).type;
    return t.text === "import" && [CPP14Lexer.Identifier, CPP14Lexer.Colon, CPP14Lexer.Less, CPP14Lexer.TemplateLess, CPP14Lexer.StringLiteral].includes(next);
  }

  /** Qt's `signals`, `slots` before `:`. */
  protected IsQtSection(): boolean {
    return this.lt(1).type === CPP14Lexer.Identifier && QT_SECTIONS.has(this.lt(1).text ?? "");
  }

  /** `TEST(Cache, Hit) {` at file scope: a name, its arguments, a body — no function's declarator looks so. */
  protected IsMacroFunction(): boolean {
    const t = this.lt(1);
    if (!isName(t.type) || this.lt(2).type !== CPP14Lexer.LeftParen || this.known(t.tokenIndex)) return false;
    return this.typeAt(this.afterMacro(t.tokenIndex)) === CPP14Lexer.LeftBrace;
  }

  /** `if (init; cond)`: a `;` inside the parentheses the statement opened. */
  protected IsInitStatement(): boolean {
    const open = this.lt(-1);
    if (open?.type !== CPP14Lexer.LeftParen) return false;
    const close = this.facts.close[open.tokenIndex] ?? -1;
    for (let i = this.following(open.tokenIndex); i >= 0 && i !== close; i = this.following(i)) {
      const type = this.typeAt(i);
      if (type === CPP14Lexer.Semi) return true;
      if (type === CPP14Lexer.LeftParen || type === CPP14Lexer.LeftBracket || type === CPP14Lexer.LeftBrace) {
        const end = this.facts.close[i] ?? -1;
        if (end < 0) return false;
        i = end;
      }
    }
    return false;
  }






}
