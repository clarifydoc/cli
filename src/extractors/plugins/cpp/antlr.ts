import { Token, TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { BuildMacros, ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { CPP14Lexer } from "../../../parsers/antlr/cpp/CPP14Lexer.js";
import {
  BinaryExpressionContext,
  ClassSpecifierContext,
  CompoundStatementContext,
  ConditionContext,
  CPP14Parser,
  DeclaratorContext,
  DeclSpecifierContext,
  DeclSpecifierSeqContext,
  ExceptionDeclarationContext,
  ForRangeDeclarationContext,
  FunctionDefinitionContext,
  HandlerContext,
  IdExpressionContext,
  InitDeclaratorContext,
  MemberDeclarationContext,
  InitializerClauseContext,
  IterationStatementContext,
  LambdaExpressionContext,
  MacroArgumentsContext,
  MacroBlockStatementContext,
  MacroFunctionDefinitionContext,
  MacroStatementContext,
  MemInitializerContext,
  NewExpression_Context,
  NoPointerDeclaratorContext,
  ParameterDeclarationContext,
  PostfixExpressionContext,
  PrimaryExpressionContext,
  SelectionStatementContext,
  SimpleDeclarationContext,
  TemplateArgumentContext,
  TemplateDeclarationContext,
  TryBlockContext,
  UnqualifiedIdContext,
} from "../../../parsers/antlr/cpp/CPP14Parser.js";
import { SPECIFIER_KEYWORDS, TYPE_KEYWORDS } from "../../../parsers/antlr/cpp/CppTypes.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { markLocalCalls, recordPatternCalls, type LocalBinding, type PatternCallName } from "../shared/antlr-calls.js";
import type { CallArguments } from "../shared/regex-base.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
import { readWithBranches } from "../shared/preprocessor-branches.js";
import { blankAsm } from "../c/rewrites.js";
import { defineCalls, leftOutCalls, tokenCalls, type CallOwner, type TokenKinds } from "../shared/token-calls.js";
import { readC } from "../c/antlr.js";
import { cppSpec } from "./index.js";
import { namesTemplateParameter } from "./classes.js";
import { cppOverloadTypeKey } from "./arg-kinds.js";
import { ITERATOR_INIT } from "../shared/c-family-locals.js";
import { cppCollectionElement, cppCollectionElementOf, cppMapTypes } from "./collection-element.js";

/** How many calls deep a chain is named. */
const CHAIN_DEPTH = 8;

/** C++'s tokens, for the calls read off them. */
const CPP_TOKENS: TokenKinds = {
  identifier: CPP14Lexer.Identifier,
  dot: CPP14Lexer.Dot,
  arrow: CPP14Lexer.Arrow,
  leftParen: CPP14Lexer.LeftParen,
  scope: CPP14Lexer.Doublecolon,
  memberArrow: true,
  namespaceQualified: true,
  directives: new Set([CPP14Lexer.Directive, CPP14Lexer.MultiLineMacro]),
  declares: new Set([...TYPE_KEYWORDS, ...SPECIFIER_KEYWORDS, CPP14Lexer.TemplateGreater, CPP14Lexer.Star, CPP14Lexer.And]),
  lexer: (input) => new CPP14Lexer(input),
};

/**
 * C++'s functions and calls as the grammars-v4 C++14 grammar reads them, in two passes (`parsers/antlr/cpp/CppTypes.ts`):
 * what each token is to the file first — the brackets, the template arguments, the names used as types — then the
 * parse, whose predicates read it to tell a declaration from an expression and `a < b` from `vector<Club>`, as a
 * compiler would with the headers. Conditionals are read as for C (`plugins/shared/preprocessor-branches.ts`).
 *
 * A function is a definition, named as the patterns name it: its declarator's last name (`Club::size` is `size`, the
 * class pass puts it on `Club`), `~Club`, `operator==`; a test macro (`TEST(Cache, Hit) { … }`) by the macro's name. It
 * owns the calls in its body, lambdas' included. A call is named as the C++ patterns name it: `Club::create(` on its
 * class, `std::sort(` and `ns::f(` on their namespace (`std.sort`, the namespace as its receiver type, so no project
 * member of the same name takes it), `a.b(` and `a->b(` alike (`this->b(` is `this.b`), a member after `->` on what
 * no name spells alone,
 * `new Club(` as `Club`, a method on a call's result as the chain from its first call; a statement macro by its name,
 * its arguments read off the tokens, as are a `#define` inside a function's.
 */
export function readCpp(source: string, macros?: BuildMacros, variant?: string): ParsedStructure {
  // A header of a project with C sources and no C++ ones (`cppReadingVariant`): C's grammar first, which is also
  // the quicker one, and C++'s when C refuses it, so nothing that parsed as C++ stops parsing. C refusing it is
  // final: the default's second try as C would only repeat that reading.
  if (variant === "c-first") {
    const asC = readC(source, macros);
    return asC.syntaxErrors === 0 ? asC : readWithBranches(blankRawStrings(normalizeSource(source)), true, read, macros);
  }
  const parsed = readWithBranches(blankRawStrings(normalizeSource(source)), true, read, macros);
  if (parsed.syntaxErrors === 0 || CPP_ONLY.test(codeOnly(blankAsm(source)).replace(/^[ \t]*#.*$/gm, ""))) return parsed;
  // A header is this plugin's whatever language includes it: one of a C project may be C that no C++ compiler takes
  // (`char *restrict p`, `tre_ctype_t class;`, `typedef void *(fn)(void *)`), and C's grammar reads it.
  const asC = readC(source, macros);
  return asC.syntaxErrors === 0 ? asC : parsed;
}

/** The text without comments and string literals, where `::` may stand in prose. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, " ");
}

/** What only C++ writes: a scope, a template, a namespace or a class with a base or body. */
const CPP_ONLY = /::|\btemplate\s*<|\bnamespace\s+\w*\s*\{|\bclass\s+\w+\s*[:{]/;

/** A raw string's start: an optional encoding prefix, `R"`, a delimiter of up to 16 characters, `(`. */
const RAW_STRING = /(?<![\w\\"'])(?:u8|u|U|L)?R"([^ ()\\\t\v\f\n"]{0,16})\(/g;

/**
 * Raw strings as `""` and spaces, newlines kept so lines and columns stay the file's: their text holds anything,
 * `)"`, `#if` lines and all, which only its closing delimiter ends — what the lexer cannot match without a predicate.
 */
function blankRawStrings(text: string): string {
  if (!text.includes('R"')) return text;
  let out = "";
  let at = 0;
  for (const m of text.matchAll(RAW_STRING)) {
    if (m.index < at) continue;
    const close = text.indexOf(`)${m[1]}"`, m.index + m[0].length);
    if (close < 0) continue;
    const end = close + m[1]!.length + 2;
    out += text.slice(at, m.index) + '""' + text.slice(m.index + 2, end).replace(/[^\n]/g, " ");
    at = end;
  }
  return out + text.slice(at);
}

/** An operator expression read as a call on its left operand, whose class may have no such member. */
interface OperatorSite { calls: PatternCallName[]; type: string; name: string; line: number; column: number; rightKey: string }

/** A declared parameter, local or field: the class it is a value of (false for a pointer, a primitive, `auto`), its overload key, its type as written. */
interface Declared { cls: string | false; key: string; text: string; pointer: boolean; iterOf?: string; /** `for (auto& p : clubs)`: the container name `p` is an element of. */ rangeOf?: string }

/** What a function sees by name: its parameters and locals, then the fields of the class it belongs to. */
interface Scope { locals: Map<string, Declared>; owner: string | null; fields: () => Map<string, Map<string, Declared>>; templates?: string[] }

/** A free `operator==(const Club&, int)` definition: the class of its first parameter and the overload key of its second. */
interface FreeOperator { left: string; right: string | null }

/** A function the walk found: its span and, as a call owner, the calls it makes and the lines it covers. */
interface Found extends CallOwner {
  span: Omit<ParsedFunctionSpan, "calls">;
}

function read(text: string, also?: string): ParsedStructure {
  let stream: Token[] = [];
  let isType: (name: string) => boolean = () => false;
  const { tree, errors } = parseWithAntlr(
    text,
    (input) => new CPP14Lexer(input),
    (tokens) => {
      const parser = new CPP14Parser(tokens);
      parser.prepare(tokens);
      stream = tokens.getTokens();
      isType = (name) => parser.isTypeName(name);
      return parser;
    },
    (parser) => parser.translationUnit(),
    // A file with an error is not read at all: core keeps the patterns' reading of it.
    { firstError: true },
  );
  if (!tree) return { functions: [], topLevelCalls: [], syntaxErrors: errors };
  const bindings = new Map<PatternCallName[], LocalBinding[]>();
  const found = walk(tree, stream, text, isType, bindings);
  defineCalls(stream, CPP_TOKENS, found);
  if (also) leftOutCalls(also, CPP_TOKENS, found);
  for (const f of found) markLocalCalls(f.calls, bindings.get(f.calls) ?? []);
  const functions = found.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls, (c) => c.receiverType !== undefined) }));
  functions.sort((a, b) => a.line - b.line);
  return { functions, topLevelCalls: [], syntaxErrors: errors };
}

function walk(root: ParseTree, stream: readonly Token[], text: string, isType: (name: string) => boolean, bindings: Map<PatternCallName[], LocalBinding[]>): Found[] {
  // Per function: the parameters and locals declared as a class-typed value (not a pointer, an array or a primitive).
  const objects = new Map<PatternCallName[], Map<string, string>>();
  const scopes = new Map<PatternCallName[], Scope>();
  let fieldMap: Map<string, Map<string, Declared>> | null = null;
  const fields = (): Map<string, Map<string, Declared>> => (fieldMap ??= collectFields(root));
  const scopeOf = (calls: PatternCallName[]): Scope => scopes.get(calls) ?? scopes.set(calls, { locals: new Map(), owner: null, fields }).get(calls)!;
  const operatorSites: OperatorSite[] = [];
  const freeOperators = new Map<string, FreeOperator[]>();
  const freeOperatorCount = new Map<string, number>();
  const stack: Array<{ node: ParseTree; owner: PatternCallName[] | null }> = [{ node: root, owner: null }];
  const found: Found[] = [];
  const own = (name: { text: string; line: number; specializedOn?: string[] }, ctx: ParserRuleContext, from: number): PatternCallName[] => {
    const calls: PatternCallName[] = [];
    const endLine = ctx.stop?.line ?? name.line;
    found.push({ span: { name: name.text, line: name.line, endLine, ...(name.specializedOn ? { specializedOn: name.specializedOn } : {}) }, calls, from, to: endLine });
    return calls;
  };
  while (stack.length > 0) {
    const { node, owner: calls } = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    let into = calls;
    if (ctx instanceof FunctionDefinitionContext) {
      // `Club() = default;` defines nothing the file states.
      if (ctx.functionBody().Assign()) continue;
      const name = declaredName(ctx.declarator(), text);
      // The definition starts at its specifiers, which the declaration around it holds.
      into = name ? own(name, ctx, ctx.parent?.start?.line ?? ctx.start!.line) : [];
      if (name) {
        const owner = enclosingClass(ctx);
        scopeOf(into).owner = owner;
        if (owner) found[found.length - 1]!.span.owner = owner;
        const bound = templateTypes(ctx);
        if (bound) scopeOf(into).templates = bound;
      }
      if (name?.text.startsWith("operator")) {
        const free = freeOperatorOf(ctx);
        if (free) (freeOperators.get(name.text) ?? freeOperators.set(name.text, []).get(name.text)!).push(free);
        // Every free definition of the operator, whatever its parameters: an overload set the left operand alone cannot choose from.
        if (isFreeDefinition(ctx)) freeOperatorCount.set(name.text, (freeOperatorCount.get(name.text) ?? 0) + 1);
      }
    } else if (ctx instanceof MacroFunctionDefinitionContext) {
      const head = (ctx.children[0] as TerminalNode).symbol;
      into = own({ text: head.text ?? "", line: head.line }, ctx, head.line);
      // The macro's arguments name the test, they call nothing: only its body is read.
      stack.push({ node: ctx.compoundStatement(), owner: into });
      continue;
    } else if (calls && ctx instanceof PostfixExpressionContext) {
      // A chain is one nested context per step: read it once, from its outermost.
      if (!(ctx.parent instanceof PostfixExpressionContext && ctx.parent.children[0] === ctx)) {
        postfixCalls(ctx, calls, text, stream, objects.get(calls), scopeOf(calls));
        connectReferences(ctx, calls);
      }
    } else if (calls && ctx instanceof BinaryExpressionContext) {
      operatorCall(ctx, calls, scopeOf(calls), stream, operatorSites);
    } else if (calls && ctx instanceof PrimaryExpressionContext && ctx.MacroName()) {
      // `SIGNAL(moved(Club *))`: the macro is called, its arguments read off the tokens.
      const head = ctx.MacroName()!.symbol;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
      const args = ctx.macroArguments();
      if (args) macroArgumentCalls(args, stream, calls);
      continue;
    } else if (calls && ctx instanceof TemplateArgumentContext && ctx.theTypeId()) {
      // `make_seq<laps()>`: without the headers a call reads as a function type; a name the file never uses as a type
      // is called, as the patterns read it.
      const first = ctx.start;
      const next = first && stream[first.tokenIndex + 1];
      if (first?.type === CPP14Lexer.Identifier && next?.type === CPP14Lexer.LeftParen && !isType(first.text ?? "") && ctx.stop) {
        tokenCalls(stream.slice(first.tokenIndex, ctx.stop.tokenIndex + 1).filter((t) => t.channel === Token.DEFAULT_CHANNEL), CPP_TOKENS, calls);
        continue;
      }
    } else if (calls && (ctx instanceof DeclaratorContext || ctx instanceof ParameterDeclarationContext || ctx instanceof SimpleDeclarationContext)) {
      // A parameter or a local the body may call (`auto kick = [](int x) { … };`, `std::function<int(int)> kick`).
      const bound = localBinding(ctx);
      if (bound) (bindings.get(calls) ?? bindings.set(calls, []).get(calls)!).push(bound);
      const templates = scopeOf(calls).templates;
      for (const [name, stated] of declaredValues(ctx)) {
        const declared = templates ? withoutTemplateTypes(stated, templates) : stated;
        const map = objects.get(calls) ?? objects.set(calls, new Map()).get(calls)!;
        scopeOf(calls).locals.set(name, declared);
        if (declared.cls) map.set(name, declared.cls);
        else map.delete(name);
      }
    } else if (calls && ctx instanceof ForRangeDeclarationContext) {
      // `for (auto& p : clubs)`: `p` is an element of `clubs`, which `p.second.m()` reads through a map's key and value.
      const over = rangeContainer(ctx);
      const id = over && /\bauto\b/.test(specifierText(ctx.declSpecifierSeq())) && ctx.declarator() ? declaredIdentifier(ctx.declarator()!) : null;
      if (id) scopeOf(calls).locals.set(id.text ?? "", { cls: false, key: "?", text: "auto", pointer: false, rangeOf: over! });
    } else if (calls && ctx instanceof NewExpression_Context) {
      newCall(ctx, calls, text, stream);
    } else if (calls && ctx instanceof MemInitializerContext) {
      // `: Player(id), name_(n)`: a base's constructor called, a member initialized — the patterns read both as calls.
      const id = ctx.memInitializerId();
      const name = id.stop?.type === CPP14Lexer.Identifier ? id.stop : null;
      if (name && id.start && ctx.LeftParen()) {
        const source = `${text.slice(id.start.start, name.stop + 1)}(`;
        const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], id.start.line, id.start.column);
        const named = byPattern === undefined ? nameCall([idStep(name)], CHAIN_DEPTH) : byPattern;
        if (named) calls.push(named);
      }
    } else if (calls && ctx instanceof SelectionStatementContext && ctx.If() && ctx.If()!.symbol.text !== "if") {
      // `IF_CONSTEXPR(c) { … } else { … }`: a macro standing for `if`, called by its name, its arguments an `if`'s.
      const head = ctx.If()!.symbol;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
    } else if (calls && (ctx instanceof TryBlockContext || ctx instanceof HandlerContext) && macroHead(ctx)) {
      // `CLUB_TRY { … } CLUB_CATCH_ALL { … }`: macros standing for `try` and `catch (…)` are called by their names.
      const head = macroHead(ctx)!;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
      const args = ctx.children.find((c) => c instanceof MacroArgumentsContext);
      if (args) macroArgumentCalls(args as MacroArgumentsContext, stream, calls);
    } else if (calls && (ctx instanceof MacroStatementContext || ctx instanceof MacroBlockStatementContext)) {
      // `SECTION("x") { … }`, `QFETCH(bool, ok);`: the macro is called by its name, its arguments read off the tokens.
      const head = (ctx.children[0] as TerminalNode).symbol;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
      const args = ctx.children[1];
      if (args instanceof MacroArgumentsContext) macroArgumentCalls(args, stream, calls);
      if (ctx instanceof MacroBlockStatementContext) stack.push({ node: ctx.statement(), owner: into });
      continue;
    }
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push({ node: ctx.children[i]!, owner: into });
  }
  // A free `operator+(const Club&, …)` the file defines is what `a + b` calls on a `Club a` that declares none.
  // An overload set is chosen by both operands: the one definition whose first parameter is the left class and whose
  // second is exactly the right operand's type, no other of that class leaving its second parameter unread.
  for (const site of operatorSites) {
    const own = (freeOperators.get(site.name) ?? []).filter((d) => d.left === site.type);
    if (own.length === 0) continue;
    const at = { name: site.name, leafName: site.name, line: site.line, column: site.column };
    if (freeOperatorCount.get(site.name) === 1) site.calls.push(at);
    else if (site.rightKey !== "?" && own.every((d) => d.right !== null && d.right !== "?") && own.filter((d) => d.right === site.rightKey).length === 1) {
      site.calls.push({ ...at, args: { argCount: 2, argKinds: [site.type, site.rightKey] } });
    }
  }
  return found;
}

/** The operators a class declares that a call reads: `a + b` calls `a`'s `operator+`. Never `=`, `&&`, `||`, `&`, `|`. */
const OPERATOR_SPELLING = new Map<number, string>([
  [CPP14Lexer.Plus, "+"], [CPP14Lexer.Minus, "-"], [CPP14Lexer.Star, "*"], [CPP14Lexer.Div, "/"],
  [CPP14Lexer.Equal, "=="], [CPP14Lexer.Less, "<"],
]);

/** One operand of an operator expression: the class it is a value of, its overload key, and how a call names it. */
interface Operand {
  cls: string | false;
  key: string;
  /** The receiver as written, for a local; absent when only its class is known (a field, a dereference). */
  receiver?: string;
  /** A member of the function's own class that this file does not declare (`kit`, `this->kit`): the class is in a header, the linker types the field. */
  member?: string;
}

const UNKNOWN: Operand = { cls: false, key: "?" };

/**
 * The type an operand states: a parameter or local (`kit`), a field of the function's own class (`kit`, `this->kit`),
 * what a pointer, smart pointer or container iterator points at (`*p`, `*it`, `*this`), or a literal. Anything else is unknown.
 */
function operandOf(ctx: ParserRuleContext, scope: Scope, stream: readonly Token[]): Operand {
  const t = ctx.getText();
  let m = /^(this->)?([A-Za-z_]\w*)$/.exec(t);
  if (m) {
    const viaThis = m[1] !== undefined;
    const local = viaThis ? undefined : scope.locals.get(m[2]!);
    const d = local ?? (scope.owner ? scope.fields().get(scope.owner)?.get(m[2]!) : undefined);
    // An out-of-line `Club::play` whose class a header declares: the name is a member the linker types from the class's fields.
    if (!d) return scope.owner && !local ? { ...UNKNOWN, member: `${viaThis ? "this." : ""}${m[2]!}` } : UNKNOWN;
    return { cls: d.cls, key: d.key, ...(local && d.cls ? { receiver: m[2]! } : {}) };
  }
  m = /^\*([A-Za-z_]\w*)$/.exec(t);
  if (m) {
    const pointee = m[1] === "this" ? scope.owner : pointeeOf(lookupIn(scope, m[1]!), scope);
    return pointee ? { cls: pointee, key: pointee } : UNKNOWN;
  }
  if (!ctx.start || !ctx.stop) return UNKNOWN;
  const kind = tokenKind(stream.slice(ctx.start.tokenIndex, ctx.stop.tokenIndex + 1).filter((tk) => tk.channel === Token.DEFAULT_CHANNEL));
  return { cls: false, key: kind.startsWith("@") ? "?" : kind };
}

/**
 * `a + b` where `a` is a class-typed value: a parameter or local (`Club a`, `const Club& a`), a field of the function's
 * own class (`kit + other`, `this->kit + other`; an out-of-line `Club::f` reads `Club`'s members), or the pointee of a
 * smart pointer or iterator (`*it + other`) — never a pointer, an array, a primitive or `auto`: a call of its class's
 * `operator+`, which the linker types through the declaration like any receiver. Only the first operator of a flat
 * chain, whose left operand is the chain's first one whatever the precedence; `a << b` is two `<` tokens. The right
 * operand's type is read the same way, to choose among free overloads.
 */
function operatorCall(ctx: BinaryExpressionContext, calls: PatternCallName[], scope: Scope, stream: readonly Token[], sites?: OperatorSite[]): void {
  const operands = ctx.pointerMemberExpression();
  const ops = ctx.binaryOperator();
  const op = ops[0];
  if (!op || operands.length < 2 || !op.start) return;
  const left = operandOf(operands[0]!, scope, stream);
  if (!left.cls && !left.member) return;
  const first = op.start;
  let spelling = OPERATOR_SPELLING.get(first.type);
  // `a << b` is `Less Less`; `a < b` a single `Less` followed by something other than a second `<`.
  if (first.type === CPP14Lexer.Less && op.getChildCount() === 2) spelling = "<<";
  if (!spelling) return;
  const leaf = `operator${spelling}`;
  const at = { line: first.line, column: first.column };
  // A member a header's class declares: named as the member is (`kit.operator+`), so the linker takes the field's own class; no free overload is chosen for it.
  if (!left.cls) {
    calls.push({ name: `${left.member}.${leaf}`, leafName: leaf, ...at });
    return;
  }
  if (left.receiver) calls.push({ name: `${left.receiver}.${leaf}`, leafName: leaf, ...at });
  else calls.push({ name: `${left.cls}.${leaf}`, leafName: leaf, receiverType: left.cls, ...at });
  // A chain's second operand is the first's right side only when it is a single operator.
  const right = ops.length === 1 ? operandOf(operands[1]!, scope, stream) : UNKNOWN;
  sites?.push({ calls, type: left.cls, name: leaf, ...at, rightKey: right.key });
}

// A `_t` name is a C typedef of a number (`uint16_t`, `size_t`, `int64_t`, `time_t`): `n * 10` on one is arithmetic.
const NOT_A_CLASS = /^(?:void|char|char8_t|char16_t|char32_t|wchar_t|bool|short|int|long|float|double|signed|unsigned|auto|decltype|iterator|const_iterator|reverse_iterator|vector|list|deque|array|map|set|multimap|multiset|unordered_map|unordered_set|string|wstring|string_view|pair|tuple|optional|variant|function|[A-Za-z_]\w*_t)$/;

/**
 * The names a parameter or local declaration declares, each as a `Declared`: whether it is a class-typed value (a type
 * spelled by a name — qualified, with template arguments, `const`, a reference — that is no primitive and no `auto`,
 * declared without `*` or `[]`) and the key the overload chooser compares it by. `Player a;` may read as two
 * specifiers and no declarator.
 */
function declaredValues(ctx: DeclaratorContext | ParameterDeclarationContext | SimpleDeclarationContext): Array<[string, Declared]> {
  const out: Array<[string, Declared]> = [];
  if (ctx instanceof ParameterDeclarationContext) {
    const decl = ctx.declarator();
    const id = decl && declaredIdentifier(decl);
    if (id) out.push([id.text ?? "", describe(ctx.declSpecifierSeq() ? specifierText(ctx.declSpecifierSeq()!) : "", decl)]);
    else {
      const name = specifierName(ctx.declSpecifierSeq());
      if (name && ctx.declSpecifierSeq()) out.push([name.text ?? "", describe(specifierText(ctx.declSpecifierSeq()!, 1), null)]);
    }
  } else if (ctx instanceof SimpleDeclarationContext) {
    const seq = ctx.declSpecifierSeq();
    const list = ctx.declarationTail().initDeclaratorList();
    if (list && seq && !typedefs(ctx)) {
      for (const init of list.initDeclarator()) {
        const decl = init.declarator();
        const id = decl && declaredIdentifier(decl);
        if (id) out.push([id.text ?? "", describe(specifierText(seq), decl, init.initializer()?.getText())]);
      }
    } else if (!list && seq && !typedefs(ctx)) {
      const name = specifierName(seq);
      if (name) out.push([name.text ?? "", describe(specifierText(seq, 1), null)]);
    }
  }
  return out;
}

/** A declaration's type: `seq` its specifiers, `decl` the declarator (null when the name was read as a specifier), `init` its initializer's text. */
function describe(seq: string, decl: DeclaratorContext | null, init?: string): Declared {
  const raw = decl?.getText() ?? "";
  const array = raw.includes("[");
  const pointer = raw.includes("*") && !array;
  const fn = !!decl && declaresFunction(decl);
  const words = valueTypeName(seq);
  const cls = !pointer && !array && !fn && words && !NOT_A_CLASS.test(words) ? words : false;
  const base = /\b(?:auto|decltype)\b/.test(seq) || array || fn ? "?" : cppOverloadTypeKey(pointer ? `${seq} *` : seq);
  // A pointer states nothing the overloads compare but a C string.
  const key = pointer && base !== "string" ? "?" : base;
  // `auto it = squad.begin();`: an iterator over what `squad` holds.
  const iterOf = /\bauto\b/.test(seq) && init?.startsWith("=") ? ITERATOR_INIT.exec(init.slice(1))?.[1] : undefined;
  return { cls, key, text: seq, pointer, ...(iterOf ? { iterOf } : {}) };
}

const lookupIn = (scope: Scope, name: string): Declared | undefined =>
  scope.locals.get(name) ?? (scope.owner ? scope.fields().get(scope.owner)?.get(name) : undefined);

/** The project class a type names, never a primitive or a library type. */
function classNamed(raw: string): string | null {
  const name = valueTypeName(raw);
  return name && !NOT_A_CLASS.test(name) ? name : null;
}

/** The element class of a container type written whole (`std::vector<Club>`), never a pointer or smart-pointer element. */
function elementClass(container: string): string | null {
  if (/[*]|_ptr/.test(/<([\s\S]*)>/.exec(container)?.[1] ?? "")) return null;
  const element = cppCollectionElement(container);
  return element ? classNamed(element) : null;
}

/** The class an iterator over a typed container reaches: `std::vector<Club>::iterator it`, `auto it = squad.begin()`. */
function iteratorElement(d: Declared | undefined, scope: Scope): string | null {
  const kind = iteratorKind(d, scope);
  return kind?.text ? elementClass(kind.text) : null;
}

/**
 * The container an iterator local walks: its type as written (`std::map<int, Club>::iterator`, or the declared type of
 * the name `auto it = squad.begin()` was taken from), and whether that name is one this file does not declare — a
 * field of the class a header declares, which the linker types.
 */
function iteratorKind(d: Declared | undefined, scope: Scope): { text: string | null; unresolved: boolean } | null {
  if (!d || d.pointer) return null;
  if (d.iterOf) {
    const container = lookupIn(scope, d.iterOf);
    if (!container) return scope.owner ? { text: null, unresolved: true } : null;
    return { text: container.pointer ? null : container.text, unresolved: false };
  }
  const m = /^(?:(?:const|typename)\s+)*(?:std::)?([a-z_]+<[\s\S]*>)::(?:const_|reverse_|const_reverse_)?iterator$/.exec(d.text.trim());
  return m ? { text: m[1]!, unresolved: false } : null;
}

/** The name a range-for walks when it is a plain one (`clubs`, `this->clubs`). */
function rangeContainer(ctx: ForRangeDeclarationContext): string | null {
  const initializer = (ctx.parent as IterationStatementContext | null)?.forRangeInitializer?.()?.getText() ?? "";
  return /^(?:this->)?([A-Za-z_]\w*)$/.exec(initializer)?.[1] ?? null;
}

/** The container a range-for local is an element of, as `iteratorKind` reads an iterator's: its declared type, or a name no function of the file declares. */
function rangeKind(d: Declared, scope: Scope): { text: string | null; unresolved: boolean } | null {
  const container = lookupIn(scope, d.rangeOf!);
  // A name no function declares, in a free function, is a global the linker cannot type: the plain name stays.
  if (!container) return scope.owner ? { text: null, unresolved: true } : null;
  return { text: container.pointer ? null : container.text, unresolved: false };
}

/** `it->second.sign()` over an iterator of a map: the call on the value (or key) class the map's type states; over a header's field, on a name the linker types. */
function pairMemberCall(named: PatternCallName, scope: Scope): PatternCallName | null {
  const m = /^([A-Za-z_]\w*)\.(first|second)\.([A-Za-z_]\w*)$/.exec(named.name);
  if (!m) return null;
  const local = scope.locals.get(m[1]!);
  const kind = local?.rangeOf ? rangeKind(local, scope) : iteratorKind(local, scope);
  if (!kind) return null;
  if (kind.unresolved) return { ...named, name: `${m[1]}$${m[2]}.${m[3]}` };
  const pair = cppMapTypes(kind.text);
  const cls = pair && (m[2] === "first" ? pair.key : pair.value);
  const classed = cls ? classNamed(cls) : null;
  return classed ? { ...named, name: `${classed}.${m[3]}`, receiverType: classed } : null;
}

const SMART_POINTER = /^(?:const\s+)?(?:std::)?(?:unique_ptr|shared_ptr)\s*<\s*(?:const\s+)?([A-Za-z_][\w:]*)\s*>$/;

/** The class an iterator or a standard smart pointer reaches by `*` and `->`. */
function wrappedPointee(d: Declared | undefined, scope: Scope): string | null {
  if (!d || d.pointer) return null;
  const smart = SMART_POINTER.exec(d.text.trim())?.[1];
  return (smart ? classNamed(smart) : null) ?? iteratorElement(d, scope);
}

/** What `*name` is: a smart pointer's or iterator's pointee, or the class a raw pointer points at. */
function pointeeOf(d: Declared | undefined, scope: Scope): string | null {
  return wrappedPointee(d, scope) ?? (d?.pointer ? classNamed(d.text) : null);
}

/** The class a function belongs to: the one whose body defines it, else the one its qualified name spells (`Club::sign`). */
function enclosingClass(def: FunctionDefinitionContext): string | null {
  for (let up: ParserRuleContext | null = def.parent; up; up = up.parent) {
    if (up instanceof ClassSpecifierContext) return up.classHead().classHeadName()?.className().getText() ?? null;
  }
  let direct: NoPointerDeclaratorContext | null = def.declarator().pointerDeclarator()?.noPointerDeclarator() ?? def.declarator().noPointerDeclarator() ?? null;
  while (direct) {
    const id = direct.declaratorId()?.idExpression();
    if (id) {
      const scope = id.qualifiedId()?.nestedNameSpecifier();
      return scope ? previousName(scope)?.text ?? null : null;
    }
    direct = direct.noPointerDeclarator() ?? direct.pointerDeclarator()?.noPointerDeclarator() ?? null;
  }
  return null;
}

/** Every class's data members, by class name then field name: a member declaration with a declarator that is no function. */
function collectFields(root: ParseTree): Map<string, Map<string, Declared>> {
  const out = new Map<string, Map<string, Declared>>();
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    if (ctx instanceof MemberDeclarationContext) {
      const seq = ctx.declSpecifierSeq();
      let owner: string | null = null;
      for (let up: ParserRuleContext | null = ctx.parent; up && !owner; up = up.parent) {
        if (up instanceof ClassSpecifierContext) owner = up.classHead().classHeadName()?.className().getText() ?? "";
      }
      if (seq && owner && !ctx.functionDefinition() && !seq.declSpecifier().some((d) => d.Typedef() !== null)) {
        const map = out.get(owner) ?? out.set(owner, new Map()).get(owner)!;
        const list = ctx.memberDeclaratorList();
        if (list) {
          for (const md of list.memberDeclarator()) {
            const decl = md.declarator();
            const id = decl && declaredIdentifier(decl);
            if (decl && id && !declaresFunction(decl)) map.set(id.text ?? "", withoutTemplateTypes(describe(specifierText(seq), decl), templateTypes(ctx)));
          }
        } else {
          const name = specifierName(seq);
          if (name) map.set(name.text ?? "", withoutTemplateTypes(describe(specifierText(seq, 1), null), templateTypes(ctx)));
        }
      }
    }
    for (const child of ctx.children) stack.push(child);
  }
  return out;
}

/** The type parameters of the templates a declaration sits in: `template<class T> struct Box { T value; }`. */
function templateTypes(ctx: ParserRuleContext): string[] | undefined {
  const names: string[] = [];
  for (let up = ctx.parent; up; up = up.parent) {
    if (!(up instanceof TemplateDeclarationContext)) continue;
    for (const p of up.templateParameterList().templateParameter()) {
      const id = p.typeParameter()?.Identifier();
      if (id) names.push(id.getText());
    }
  }
  return names.length > 0 ? names : undefined;
}

/**
 * A template's type parameter is no class: a value whose type IS one (`T a`, `T&`, `unique_ptr<T>`, `vector<T>`) is of
 * no class the project declares, whatever the project's own `T` is. `Fixture<T>` is a `Fixture`.
 */
function withoutTemplateTypes(d: Declared, templates: string[] | undefined): Declared {
  return templates && namesTemplateParameter(d.text, templates) ? { cls: false, key: "?", text: "", pointer: false } : d;
}

/** The class a type spelled by a name stands for, its last name (`const league::Club&` → `Club`); null when it is no plain name. */
function valueTypeName(seq: string): string | null {
  const words = seq.replace(/\b(?:const|volatile|static|register|mutable|constexpr)\b/g, " ").replace(/&/g, " ").replace(/<.*>/s, "").trim();
  // A library's container or string is no project class, whatever a project class of the same last name declares.
  if (!/^[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)*$/.test(words) || /^(?:std|boost|absl)\s*::/.test(words)) return null;
  return words.split("::").at(-1)!.trim();
}

/** The specifiers' text, the last `drop` of them left off, words kept apart. */
function specifierText(seq: DeclSpecifierSeqContext, drop = 0): string {
  const all = seq.declSpecifier();
  return all.slice(0, all.length - drop).map((d) => d.getText()).join(" ");
}

/**
 * `Club operator+(const Club& a, const Club& b) {…}` outside any class and with no `Class::` in front: the key
 * `Club|operator+` of its first parameter's type, the left operand it is called on. Null for a member, a friend defined in
 * its class, or a first parameter no plain name types.
 */
/** A definition outside any class with no `Class::` in front of its name. */
function isFreeDefinition(def: FunctionDefinitionContext): boolean {
  for (let up: ParserRuleContext | null = def.parent; up; up = up.parent) if (up instanceof ClassSpecifierContext) return false;
  return !/::/.test(def.declarator().getText());
}

function freeOperatorOf(def: FunctionDefinitionContext): FreeOperator | null {
  for (let up: ParserRuleContext | null = def.parent; up; up = up.parent) if (up instanceof ClassSpecifierContext) return null;
  const top = def.declarator().pointerDeclarator()?.noPointerDeclarator() ?? def.declarator().noPointerDeclarator();
  const id = top?.noPointerDeclarator()?.declaratorId()?.idExpression();
  if (!top || !id || id.qualifiedId()) return null;
  const params = top.parametersAndQualifiers()?.parameterDeclarationClause()?.parameterDeclarationList()?.parameterDeclaration() ?? [];
  const first = params[0];
  if (!first || !first.declSpecifierSeq()) return null;
  const decl = first.declarator();
  if (decl && /[*\[]/.test(decl.getText())) return null;
  const type = valueTypeName(specifierText(first.declSpecifierSeq()!));
  if (!type || NOT_A_CLASS.test(type) || templateTypes(def)?.includes(type)) return null;
  // Only a binary operator is chosen by its second parameter's type; a unary one never matches an expression of two operands.
  const second = params.length === 2 && params[1]!.declSpecifierSeq() ? describe(specifierText(params[1]!.declSpecifierSeq()!), params[1]!.declarator()) : null;
  return { left: type, right: second ? second.key : null };
}

/** The macro standing for `try` or `catch (…)` that opens a try block or a handler: a first token the keyword's own text is not. */
function macroHead(ctx: TryBlockContext | HandlerContext): Token | null {
  const first = ctx.children[0];
  return first instanceof TerminalNode && (first.symbol.type === CPP14Lexer.CatchMacro || (first.symbol.type === CPP14Lexer.Try && first.symbol.text !== "try")) ? first.symbol : null;
}

/** The calls in a macro's arguments, read off their tokens. */
function macroArgumentCalls(args: MacroArgumentsContext, stream: readonly Token[], calls: PatternCallName[]): void {
  if (!args.start || !args.stop) return;
  tokenCalls(stream.slice(args.start.tokenIndex, args.stop.tokenIndex + 1).filter((t) => t.channel === Token.DEFAULT_CHANNEL), CPP_TOKENS, calls);
}

/**
 * What a declaration in a body binds, and where: a local (a block's, a `for`'s, a condition's, a `catch`'s) to the end
 * of the scope declaring it, a parameter of the function or lambda being defined to the end of its body. Null for a
 * function it declares (`int kick(int);` is the file's `kick`), a typedef, a parameter of a declared function type,
 * and a qualified name. Without the headers `Engine kick` may read as two specifiers and no declarator: the name is
 * then the last specifier, after a type.
 */
function localBinding(ctx: DeclaratorContext | ParameterDeclarationContext | SimpleDeclarationContext): LocalBinding | null {
  let name: Token | null = null;
  let scope: ParserRuleContext | null = null;
  const parameter = (decl: ParameterDeclarationContext): ParserRuleContext | null => {
    for (let up = decl.parent; up; up = up.parent) {
      if (up instanceof FunctionDefinitionContext || up instanceof LambdaExpressionContext) return up;
      if (up instanceof ParameterDeclarationContext || up instanceof SimpleDeclarationContext) return null;
    }
    return null;
  };
  if (ctx instanceof ParameterDeclarationContext) {
    if (ctx.declarator() || ctx.abstractDeclarator()) return null;
    name = specifierName(ctx.declSpecifierSeq());
    scope = name && parameter(ctx);
  } else if (ctx instanceof SimpleDeclarationContext) {
    const tail = ctx.declarationTail();
    if (tail.initDeclaratorList() || tail.structuredBinding() || typedefs(ctx)) return null;
    name = specifierName(ctx.declSpecifierSeq());
    scope = name && blockScope(ctx);
  } else {
    const parent = ctx.parent;
    if (parent instanceof InitDeclaratorContext || parent instanceof ConditionContext || parent instanceof ForRangeDeclarationContext || parent instanceof ExceptionDeclarationContext) {
      if (declaresFunction(ctx)) return null;
      for (let up = parent.parent; up; up = up.parent) {
        if (up instanceof SimpleDeclarationContext && typedefs(up)) return null;
        if (up instanceof SimpleDeclarationContext || up instanceof CompoundStatementContext) break;
      }
      scope = blockScope(parent);
    } else if (parent instanceof ParameterDeclarationContext) {
      scope = parameter(parent);
    }
    name = scope && declaredIdentifier(ctx);
  }
  if (!name || !scope?.stop) return null;
  return { name: name.text ?? "", line: name.line, column: name.column, endLine: scope.stop.line, endColumn: scope.stop.column };
}

/** The block, statement, lambda or function a local declaration's name lasts to the end of. */
function blockScope(from: ParserRuleContext): ParserRuleContext | null {
  for (let up = from.parent; up; up = up.parent) {
    if (up instanceof CompoundStatementContext || up instanceof IterationStatementContext || up instanceof SelectionStatementContext
      || up instanceof HandlerContext || up instanceof LambdaExpressionContext || up instanceof FunctionDefinitionContext) return up;
  }
  return null;
}

/** Whether a declaration is a `typedef`: it names a type, never a value to call. */
function typedefs(decl: SimpleDeclarationContext): boolean {
  return decl.declSpecifierSeq()?.declSpecifier().some((d) => d.Typedef() !== null) === true;
}

/** `Engine kick` read as specifiers only: the last one when it is a plain name after a type, else null. */
function specifierName(seq: DeclSpecifierSeqContext | null): Token | null {
  const specifiers = seq?.declSpecifier() ?? [];
  if (specifiers.length < 2) return null;
  const typeOf = (d: DeclSpecifierContext) => d.typeSpecifier()?.trailingTypeSpecifier()?.simpleTypeSpecifier() ?? null;
  const last = typeOf(specifiers.at(-1)!);
  if (!last?.theTypeName() || last.nestedNameSpecifier() || !/^[A-Za-z_]\w*$/.test(last.getText())) return null;
  if (!specifiers.slice(0, -1).some((d) => typeOf(d) !== null)) return null;
  return last.start;
}

/** Whether a declarator declares a function (`kick(int)`, `auto kick() -> int`), not a value — a function pointer is a value. */
function declaresFunction(declarator: DeclaratorContext): boolean {
  if (declarator.trailingReturnType()) return true;
  const top = declarator.pointerDeclarator()?.noPointerDeclarator();
  return !!top?.parametersAndQualifiers() && !!top.noPointerDeclarator()?.declaratorId();
}

/** The unqualified name a declarator declares, through parentheses (`(*kick)(int)`); null for a qualified one. */
function declaredIdentifier(declarator: DeclaratorContext): Token | null {
  let direct: NoPointerDeclaratorContext | null = declarator.pointerDeclarator()?.noPointerDeclarator() ?? declarator.noPointerDeclarator() ?? null;
  while (direct) {
    const id = direct.declaratorId()?.idExpression();
    if (id) return id.qualifiedId() ? null : id.unqualifiedId()?.Identifier()?.symbol ?? null;
    direct = direct.noPointerDeclarator() ?? direct.pointerDeclarator()?.noPointerDeclarator() ?? null;
  }
  return null;
}

/** The name a declarator declares, as the patterns name a definition: its last name, `~Club`, `operator==`. */
function declaredName(declarator: DeclaratorContext | null, text: string): { text: string; line: number; specializedOn?: string[] } | null {
  // `auto kick() -> bool` declares through the trailing-return form, with no pointer declarator.
  let direct: NoPointerDeclaratorContext | null = declarator?.pointerDeclarator()?.noPointerDeclarator() ?? declarator?.noPointerDeclarator() ?? null;
  while (direct) {
    const id = direct.declaratorId()?.idExpression();
    if (id) {
      const unqualified = id.unqualifiedId() ?? id.qualifiedId()?.unqualifiedId();
      const specializedOn = unqualified ? templateArgsOf(unqualified, text) : undefined;
      return unqualified ? { text: unqualifiedName(unqualified), line: unqualified.start!.line, ...(specializedOn ? { specializedOn } : {}) } : null;
    }
    direct = direct.noPointerDeclarator() ?? direct.pointerDeclarator()?.noPointerDeclarator() ?? null;
  }
  return null;
}

/** The template arguments written on a name (`convert<std::string>` → `["std::string"]`), as the source spells them. */
function templateArgsOf(id: UnqualifiedIdContext, text: string): string[] | undefined {
  const template = id.templateId();
  const list = template?.simpleTemplateId()?.templateArgumentList() ?? template?.templateArgumentList();
  const args = list?.templateArgument().filter((a) => a.start && a.stop).map((a) => text.slice(a.start!.start, a.stop!.stop + 1).trim());
  return args && args.length > 0 ? args : undefined;
}

/** An unqualified name as written, template arguments left off: `size`, `~Club`, `operator==`, `get` of `get<T>`. */
function unqualifiedName(id: UnqualifiedIdContext): string {
  const template = id.templateId();
  if (template) return template.simpleTemplateId()?.templateName().getText() ?? template.getText();
  return id.getText();
}

const idStep = (token: Token): CalleeStep => ({ kind: "id", name: token.text ?? "", line: token.line, column: token.column });

/** The steps an id-expression names: `kick`, `get` of `get<T>`, `Club::create` keeping its class, `ns::f` as `f`. */
function idSteps(id: IdExpressionContext): CalleeStep[] {
  const qualified = id.qualifiedId();
  const unqualified = id.unqualifiedId() ?? qualified?.unqualifiedId();
  const name = unqualified?.Identifier()?.symbol ?? unqualified?.templateId()?.simpleTemplateId()?.templateName().Identifier().symbol;
  if (!name) return [{ kind: "other", bare: false }];
  const scope = qualified?.nestedNameSpecifier();
  const owner = scope?.stop && scope.stop.type === CPP14Lexer.Doublecolon ? previousName(scope) : null;
  return owner && /^[A-Z]/.test(owner.text ?? "") ? [idStep(owner), idStep(name)] : [idStep(name)];
}

/** The last name before a nested-name-specifier's closing `::`: `Club` of `league::Club::`. */
function previousName(scope: ParserRuleContext): Token | null {
  let last: Token | null = null;
  const visit = (node: ParseTree): void => {
    if (node instanceof TerminalNode) {
      if (node.symbol.type === CPP14Lexer.Identifier) last = node.symbol;
      return;
    }
    // A template's arguments are not its name: `Box<Club>::` is `Box`.
    if ((node as ParserRuleContext).ruleIndex === CPP14Parser.RULE_templateArgumentList) return;
    for (const child of (node as ParserRuleContext).children) visit(child);
  };
  visit(scope);
  return last;
}

/** The calls a postfix chain makes: each `(…)` calls what comes before it, named by the patterns first. */
function postfixCalls(outer: PostfixExpressionContext, calls: PatternCallName[], text: string, stream: readonly Token[], objects?: ReadonlyMap<string, string>, scope?: Scope): void {
  const chain: PostfixExpressionContext[] = [];
  for (let link: PostfixExpressionContext | null = outer; link; ) {
    chain.push(link);
    const first: ParseTree | undefined = link.children[0];
    link = first instanceof PostfixExpressionContext ? first : null;
  }
  chain.reverse();
  const steps: CalleeStep[] = [];
  const start = chain[0]!.start!;
  // `*u` over a smart pointer or an iterator is what it points at, which the overloads compare.
  const deref = scope ? (name: string): string | null => wrappedPointee(lookupIn(scope, name), scope) : undefined;
  // The class the head of the chain is known to be (`it->`, `(*it).`, `std::next(it)->`): the head step then reads as that class.
  let typed: { cls: string; deref: boolean; pointer?: boolean; orig?: CalleeStep } | null = null;
  // The element class of `std::next(it)`'s iterator, until the arrow that takes it.
  let advanced: string | null = null;
  // `(*it)` over an iterator of a field a header declares: `(*it).m()` is `it.m`, `(*it)->m()` is the pointee's, named `it$deref`.
  let aliased = false;
  for (const link of chain) {
    const kids = link.children;
    const first = kids[0];
    if (!(first instanceof PostfixExpressionContext)) {
      // `(*it).kick(`: the element an iterator or smart pointer reaches is the receiver's type, as `it->kick(` states it.
      const pointee = scope && derefHead(link, scope);
      if (pointee && "alias" in pointee) {
        steps.push({ kind: "id", name: pointee.alias, line: start.line, column: start.column });
        aliased = true;
        continue;
      }
      if (pointee) {
        typed = { cls: pointee.cls, deref: true, pointer: pointee.pointer };
        steps.push({ kind: "id", name: pointee.cls, line: start.line, column: start.column });
        continue;
      }
      steps.push(...headSteps(link));
      continue;
    }
    const op = kids[1];
    if (!(op instanceof TerminalNode)) continue;
    const type = op.symbol.type;
    if (type === CPP14Lexer.LeftParen) {
      const source = `${text.slice(start.start, op.symbol.start)}(`;
      const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], start.line, start.column);
      let named = byPattern === undefined ? memberPathCall(steps) ?? nameCall(steps, CHAIN_DEPTH) : byPattern;
      // `it->sign(` over a container's iterator: the member of the element the container holds (a smart pointer, a pointer is typed by the linker).
      // A chain (`it->club().sign()`) goes on from the typed head, named as the class's own.
      if (named && typed && steps.length === 2 && steps[0]!.kind === "id" && steps[1]!.kind === "id") {
        named = { ...named, name: `${typed.cls}.${steps[1]!.name}`, receiverType: typed.cls };
      } else if (typed && byPattern === undefined && steps.length > 2 && steps.every((s) => s.kind === "id")) {
        // A path through the element's fields (`it->first.lace(`) is not the class's own: named as before, from the head as written.
        const path = typed.orig ? [typed.orig, ...steps.slice(1)] : null;
        named = path ? memberPathCall(path) ?? nameCall(path, CHAIN_DEPTH) : null;
      }
      // `std::next(it)` / `std::prev(it)`: the iterator the standard function steps (a project function of that name is not it).
      const advance = scope && /^(?:::)?std::(?:next|prev)$/.test(first.getText())
        ? /^[A-Za-z_]\w*$/.exec(link.expressionList()?.initializerList().initializerClause()[0]?.getText() ?? "")?.[0] : undefined;
      if (advance) advanced = iteratorElement(lookupIn(scope!, advance), scope!);
      // `it->second.sign(` over a map's iterator: the value class's own call.
      if (named && scope && !typed) named = pairMemberCall(named, scope) ?? named;
      if (named) calls.push(withArguments(named, argumentsOf(link.expressionList(), stream, calleeTemplateArgs(first, text), deref)));
      steps.push(callStep(steps));
    } else if (type === CPP14Lexer.Dot || type === CPP14Lexer.Arrow) {
      if (type === CPP14Lexer.Arrow && scope && !typed) {
        // `it->` over an iterator, `std::next(it)->`: the head reads as the element class.
        const head = steps.length === 1 && steps[0]!.kind === "id" ? iteratorElement(lookupIn(scope, steps[0]!.name), scope) : advanced;
        if (head) {
          typed = { cls: head, deref: false, ...(steps[0]!.kind === "id" && steps.length === 1 ? { orig: steps[0] } : {}) };
          steps.length = 0;
          steps.push({ kind: "id", name: head, line: start.line, column: start.column });
        }
      } else if (typed?.deref && steps.length === 1 && (type === CPP14Lexer.Arrow) !== !!typed.pointer) {
        // `(*it)->kick(` over values, `(*it).kick(` over pointers: the element is itself a pointer, which no name spells.
        // (A pointer element reached by `(*it)->` is the class it points at: the head stays typed.)
        typed = null;
        steps[0] = { kind: "other", bare: false };
      }
      advanced = null;
      if (aliased && type === CPP14Lexer.Arrow && steps.length === 1 && steps[0]!.kind === "id") steps[0] = { ...steps[0]!, name: `${steps[0]!.name}$deref` };
      aliased = false;
      // `p->kick(` is `p.kick`, as `p.kick(` is: the linker types `p` through its declaration, a field's or a local's.
      // A member after `->` on what no name spells (`(*it)->kick(`, `this->kick(`) is named alone, as the patterns read it.
      if (type === CPP14Lexer.Arrow && steps.at(-1)?.kind === "other") steps.push({ kind: "other", bare: true });
      const member = kids.find((k) => k instanceof IdExpressionContext);
      // `p->final()`: a contextual keyword names a member too.
      const keyword = kids.find((k) => k instanceof TerminalNode && (k.symbol.type === CPP14Lexer.Final || k.symbol.type === CPP14Lexer.Override));
      if (member) steps.push(...idSteps(member as IdExpressionContext).slice(-1));
      else if (keyword) steps.push(idStep((keyword as TerminalNode).symbol));
      else steps.push({ kind: "other", bare: false });
    } else if (type === CPP14Lexer.LeftBracket && steps.length === 1 && steps[0]!.kind === "id" && objects?.has(steps[0]!.name)) {
      // `squad[i]` on a typed receiver calls its `operator[]`; the chain goes on as an unnamed step, so `squad[i].sign()` reads on.
      calls.push({ name: `${steps[0]!.name}.operator[]`, leafName: "operator[]", line: op.symbol.line, column: op.symbol.column });
      steps.push({ kind: "other", bare: false });
    } else {
      steps.push({ kind: "other", bare: false });
    }
  }
}

/** The class `(*it)` is over an iterator, a smart pointer or a pointer, when the link is exactly that parenthesized dereference. */
function derefHead(link: PostfixExpressionContext, scope: Scope): { cls: string; pointer: boolean } | { alias: string } | null {
  const primary = link.children[0];
  if (!(primary instanceof PrimaryExpressionContext) || primary.idExpression()) return null;
  const m = /^\(\*([A-Za-z_]\w*)\)$/.exec(primary.getText());
  if (!m) return null;
  if (m[1] === "this") return scope.owner ? { cls: scope.owner, pointer: false } : null;
  const d = lookupIn(scope, m[1]!);
  const pointee = pointeeOf(d, scope);
  if (pointee) return { cls: pointee, pointer: false };
  const kind = iteratorKind(d, scope);
  // `auto it = boots.begin()` over a field a header declares: `(*it)` is read as `it`, whose element the linker types.
  if (kind?.unresolved) return { alias: m[1]! };
  // An iterator over pointers (`vector<Boot*>`, `vector<unique_ptr<Boot>>`): only `(*it)->` reaches the pointee.
  const element = kind?.text ? cppCollectionElementOf(kind.text) : null;
  const cls = element?.pointer ? classNamed(element.name) : null;
  return cls ? { cls, pointer: true } : null;
}

/**
 * Qt's pointer-to-member `connect(button, &QPushButton::clicked, this, &ClubWindow::saveClub)`: the slot (any argument
 * after the signal) is handed on, so the connecting function references it — named as a static call of it would be
 * (`ClubWindow.saveClub`, on the class `ClubWindow`). A bare `&saveClub` names a function; whether it is one is the
 * linker's to say.
 */
function connectReferences(ctx: PostfixExpressionContext, calls: PatternCallName[]): void {
  if (!ctx.LeftParen()) return;
  const callee = ctx.children[0]?.getText() ?? "";
  if (callee !== "connect" && !callee.endsWith("::connect")) return;
  const args = ctx.expressionList()?.initializerList().initializerClause() ?? [];
  for (const arg of args.slice(2)) {
    const m = /^&((?:[A-Za-z_]\w*::)*)([A-Za-z_]\w*)$/.exec(arg.getText());
    if (!m || !arg.start) continue;
    const owner = m[1] ? m[1].split("::").filter(Boolean).at(-1)! : undefined;
    const named = owner && /^[A-Z]/.test(owner)
      ? { name: `${owner}.${m[2]}`, leafName: m[2]!, receiverType: owner }
      : owner ? null : { name: m[2]!, leafName: m[2]! };
    if (named) calls.push({ ...named, line: arg.start.line, column: arg.start.column, passed: "argument" });
  }
}

/** Longest member path named whole (`c->home_season_->Ref(` is `c.home_season_.Ref`): what the linker follows. */
const MEMBER_PATH_DEPTH = 5;

/**
 * A call through a path of members — `c->home_season_->Ref(`, `this->crew_->pit_lane.OpenGate(` — named by the
 * whole path, so the linker types each member through the declaring class's fields, as it does `this.a.b.m()`
 * elsewhere; the shared naming keeps only the last two names, which no declaration types. Null when a step is not a
 * name or the path is two names or fewer.
 */
function memberPathCall(steps: readonly CalleeStep[]): PatternCallName | null {
  if (steps.length < 3 || steps.length > MEMBER_PATH_DEPTH || steps.some((s) => s.kind !== "id")) return null;
  const ids = steps as ReadonlyArray<Extract<CalleeStep, { kind: "id" }>>;
  const head = ids[0]!;
  const leaf = ids.at(-1)!.name;
  return { name: ids.map((s) => s.name).join("."), leafName: leaf, line: head.line, column: head.column };
}

/**
 * The first step of a chain: a name, `this` (`this->train(` is `this.train`, the enclosing class's own member, as the
 * call scan reads it), or what no name spells.
 */
function headSteps(link: PostfixExpressionContext): CalleeStep[] {
  const primary = link.children[0];
  if (!(primary instanceof PrimaryExpressionContext)) return [{ kind: "other", bare: false }];
  const id = primary.idExpression();
  if (id) return idSteps(id);
  const head = primary.children[0];
  if (head instanceof TerminalNode && head.symbol.type === CPP14Lexer.This) return [idStep(head.symbol)];
  return [{ kind: "other", bare: false }];
}

/** `new Club(…)`: the type is called, named as the patterns read `Club(`. */
function newCall(ctx: NewExpression_Context, calls: PatternCallName[], text: string, stream: readonly Token[]): void {
  const init = ctx.newInitializer_();
  const type = ctx.newTypeId();
  if (!init || !type || init.start?.type !== CPP14Lexer.LeftParen || !type.start || !type.stop || type.stop.type !== CPP14Lexer.Identifier) return;
  const name = type.stop;
  const source = `new ${text.slice(type.start.start, init.start.start)}(`;
  const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], type.start.line, type.start.column);
  const named = byPattern === undefined ? nameCall([idStep(name)], CHAIN_DEPTH) : byPattern;
  if (named) calls.push(withArguments(named, argumentsOf(init.expressionList(), stream)));
}

/** The call with the arguments it passes, when they are all told. */
function withArguments(named: PatternCallName, args: CallArguments | undefined): PatternCallName {
  return args ? { ...named, args } : named;
}

/** The template arguments a call writes on its callee: `convert<int>(x)`, `Util::convert<int>(x)`, `p->convert<int>(x)`. */
function calleeTemplateArgs(callee: ParseTree | undefined, text: string): string[] | undefined {
  if (!(callee instanceof PostfixExpressionContext)) return undefined;
  const head = callee.children[0];
  const id = head instanceof PrimaryExpressionContext ? head.idExpression() : callee.children.find((k) => k instanceof IdExpressionContext) as IdExpressionContext | undefined;
  const unqualified = id?.unqualifiedId() ?? id?.qualifiedId()?.unqualifiedId();
  return unqualified ? templateArgsOf(unqualified, text) : undefined;
}

/**
 * How many arguments a call passes and what each is as its own expression says (`CallInfo.argKinds`: a literal's
 * type, `@name` for a variable the linker types from the function's parameters and fields, `?` otherwise). Undefined
 * where a pack expansion hides the count.
 */
function argumentsOf(list: { initializerList(): { initializerClause(): InitializerClauseContext[]; Ellipsis(): TerminalNode[] } } | null, stream: readonly Token[], templateArgs?: string[], deref?: (name: string) => string | null): CallArguments | undefined {
  const clauses = list?.initializerList().initializerClause() ?? [];
  if (list && list.initializerList().Ellipsis().length > 0) return undefined;
  const kinds = clauses.map((c) => argumentKind(c, stream, deref));
  return {
    argCount: clauses.length,
    ...(kinds.some((k) => k !== "?") ? { argKinds: kinds } : {}),
    ...(templateArgs ? { templateArgs } : {}),
  };
}

/** One argument's kind: a literal's canonical type, `@name` for a plain name, `?` for any other expression. */
function argumentKind(clause: InitializerClauseContext, stream: readonly Token[], deref?: (name: string) => string | null): string {
  if (!clause.start || !clause.stop) return "?";
  return tokenKind(stream.slice(clause.start.tokenIndex, clause.stop.tokenIndex + 1).filter((t) => t.channel === Token.DEFAULT_CHANNEL), deref);
}

/** The kind the tokens of one expression state; `deref` types `*name` for a smart pointer or an iterator. */
function tokenKind(tokens: readonly Token[], deref?: (name: string) => string | null): string {
  // `-5` is an int too.
  const body = tokens.length === 2 && (tokens[0]!.type === CPP14Lexer.Minus || tokens[0]!.type === CPP14Lexer.Plus) ? tokens.slice(1) : tokens;
  if (body.length === 0) return "?";
  if (body.every((t) => t.type === CPP14Lexer.StringLiteral)) return /^"/.test(body[0]!.text ?? "") ? "string" : "?";
  // `*club` is `@*club` (a dereferenced variable: the linker takes it only when the variable's type is a class of the project, never an iterator or smart pointer) and `this->club` is the variable `club`.
  if (body.length === 2 && body[0]!.type === CPP14Lexer.Star && body[1]!.type === CPP14Lexer.Identifier) return deref?.(body[1]!.text ?? "") ?? `@*${body[1]!.text}`;
  if (body.length === 3 && body[0]!.type === CPP14Lexer.This && body[1]!.type === CPP14Lexer.Arrow && body[2]!.type === CPP14Lexer.Identifier) return `@${body[2]!.text}`;
  if (body.length !== 1) return "?";
  const token = body[0]!;
  const t = (token.text ?? "").toLowerCase();
  switch (token.type) {
    case CPP14Lexer.IntegerLiteral: return t.includes("l") ? "long" : "int";
    case CPP14Lexer.FloatingLiteral: return /f$/.test(t) && !t.startsWith("0x") ? "float" : "double";
    case CPP14Lexer.CharacterLiteral: return t.startsWith("'") ? "char" : "?";
    case CPP14Lexer.BooleanLiteral: return "boolean";
    case CPP14Lexer.PointerLiteral: return "null";
    case CPP14Lexer.Identifier: return tokens.length === 1 ? `@${token.text}` : "?";
    default: return "?";
  }
}
