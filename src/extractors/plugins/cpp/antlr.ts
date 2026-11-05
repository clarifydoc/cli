import { Token, TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { BuildMacros, ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { CPP14Lexer } from "../../../parsers/antlr/cpp/CPP14Lexer.js";
import {
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
  UnqualifiedIdContext,
} from "../../../parsers/antlr/cpp/CPP14Parser.js";
import { SPECIFIER_KEYWORDS, TYPE_KEYWORDS } from "../../../parsers/antlr/cpp/CppTypes.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { markLocalCalls, recordPatternCalls, type LocalBinding, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
import { readWithBranches } from "../shared/preprocessor-branches.js";
import { defineCalls, leftOutCalls, tokenCalls, type CallOwner, type TokenKinds } from "../shared/token-calls.js";
import { readC } from "../c/antlr.js";
import { cppSpec } from "./index.js";

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
  if (parsed.syntaxErrors === 0 || CPP_ONLY.test(codeOnly(source))) return parsed;
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
  const stack: Array<{ node: ParseTree; owner: PatternCallName[] | null }> = [{ node: root, owner: null }];
  const found: Found[] = [];
  const own = (name: { text: string; line: number }, ctx: ParserRuleContext, from: number): PatternCallName[] => {
    const calls: PatternCallName[] = [];
    const endLine = ctx.stop?.line ?? name.line;
    found.push({ span: { name: name.text, line: name.line, endLine }, calls, from, to: endLine });
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
      const name = declaredName(ctx.declarator());
      // The definition starts at its specifiers, which the declaration around it holds.
      into = name ? own(name, ctx, ctx.parent?.start?.line ?? ctx.start!.line) : [];
    } else if (ctx instanceof MacroFunctionDefinitionContext) {
      const head = (ctx.children[0] as TerminalNode).symbol;
      into = own({ text: head.text ?? "", line: head.line }, ctx, head.line);
      // The macro's arguments name the test, they call nothing: only its body is read.
      stack.push({ node: ctx.compoundStatement(), owner: into });
      continue;
    } else if (calls && ctx instanceof PostfixExpressionContext) {
      // A chain is one nested context per step: read it once, from its outermost.
      if (!(ctx.parent instanceof PostfixExpressionContext && ctx.parent.children[0] === ctx)) {
        postfixCalls(ctx, calls, text);
        connectReferences(ctx, calls);
      }
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
    } else if (calls && ctx instanceof NewExpression_Context) {
      newCall(ctx, calls, text);
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
  return found;
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
function declaredName(declarator: DeclaratorContext | null): { text: string; line: number } | null {
  // `auto kick() -> bool` declares through the trailing-return form, with no pointer declarator.
  let direct: NoPointerDeclaratorContext | null = declarator?.pointerDeclarator()?.noPointerDeclarator() ?? declarator?.noPointerDeclarator() ?? null;
  while (direct) {
    const id = direct.declaratorId()?.idExpression();
    if (id) {
      const unqualified = id.unqualifiedId() ?? id.qualifiedId()?.unqualifiedId();
      return unqualified ? { text: unqualifiedName(unqualified), line: unqualified.start!.line } : null;
    }
    direct = direct.noPointerDeclarator() ?? direct.pointerDeclarator()?.noPointerDeclarator() ?? null;
  }
  return null;
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
function postfixCalls(outer: PostfixExpressionContext, calls: PatternCallName[], text: string): void {
  const chain: PostfixExpressionContext[] = [];
  for (let link: PostfixExpressionContext | null = outer; link; ) {
    chain.push(link);
    const first: ParseTree | undefined = link.children[0];
    link = first instanceof PostfixExpressionContext ? first : null;
  }
  chain.reverse();
  const steps: CalleeStep[] = [];
  const start = chain[0]!.start!;
  for (const link of chain) {
    const kids = link.children;
    const first = kids[0];
    if (!(first instanceof PostfixExpressionContext)) {
      steps.push(...headSteps(link));
      continue;
    }
    const op = kids[1];
    if (!(op instanceof TerminalNode)) continue;
    const type = op.symbol.type;
    if (type === CPP14Lexer.LeftParen) {
      const source = `${text.slice(start.start, op.symbol.start)}(`;
      const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], start.line, start.column);
      const named = byPattern === undefined ? memberPathCall(steps) ?? nameCall(steps, CHAIN_DEPTH) : byPattern;
      if (named) calls.push(named);
      steps.push(callStep(steps));
    } else if (type === CPP14Lexer.Dot || type === CPP14Lexer.Arrow) {
      // `p->kick(` is `p.kick`, as `p.kick(` is: the linker types `p` through its declaration, a field's or a local's.
      // A member after `->` on what no name spells (`(*it)->kick(`, `this->kick(`) is named alone, as the patterns read it.
      if (type === CPP14Lexer.Arrow && steps.at(-1)?.kind === "other") steps.push({ kind: "other", bare: true });
      const member = kids.find((k) => k instanceof IdExpressionContext);
      // `p->final()`: a contextual keyword names a member too.
      const keyword = kids.find((k) => k instanceof TerminalNode && (k.symbol.type === CPP14Lexer.Final || k.symbol.type === CPP14Lexer.Override));
      if (member) steps.push(...idSteps(member as IdExpressionContext).slice(-1));
      else if (keyword) steps.push(idStep((keyword as TerminalNode).symbol));
      else steps.push({ kind: "other", bare: false });
    } else {
      steps.push({ kind: "other", bare: false });
    }
  }
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
function newCall(ctx: NewExpression_Context, calls: PatternCallName[], text: string): void {
  const init = ctx.newInitializer_();
  const type = ctx.newTypeId();
  if (!init || !type || init.start?.type !== CPP14Lexer.LeftParen || !type.start || !type.stop || type.stop.type !== CPP14Lexer.Identifier) return;
  const name = type.stop;
  const source = `new ${text.slice(type.start.start, init.start.start)}(`;
  const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], type.start.line, type.start.column);
  const named = byPattern === undefined ? nameCall([idStep(name)], CHAIN_DEPTH) : byPattern;
  if (named) calls.push(named);
}
