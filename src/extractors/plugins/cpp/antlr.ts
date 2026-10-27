import { Token, TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { CPP14Lexer } from "../../../parsers/antlr/cpp/CPP14Lexer.js";
import {
  CPP14Parser,
  DeclaratorContext,
  FunctionDefinitionContext,
  IdExpressionContext,
  MacroArgumentsContext,
  MacroBlockStatementContext,
  MacroFunctionDefinitionContext,
  MacroStatementContext,
  MemInitializerContext,
  NewExpression_Context,
  NoPointerDeclaratorContext,
  PostfixExpressionContext,
  PrimaryExpressionContext,
  UnqualifiedIdContext,
} from "../../../parsers/antlr/cpp/CPP14Parser.js";
import { SPECIFIER_KEYWORDS, TYPE_KEYWORDS } from "../../../parsers/antlr/cpp/CppTypes.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { callStep, nameCall, patternNamedCall, type CalleeStep } from "../shared/callee-names.js";
import { readWithBranches } from "../shared/preprocessor-branches.js";
import { defineCalls, leftOutCalls, tokenCalls, type CallOwner, type TokenKinds } from "../shared/token-calls.js";
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
 * class, `std::sort(` and `ns::f(` as the function, `a.b(`, a member after `->` alone, `new Club(` as `Club`, a method
 * on a call's result as the chain from its first call; a statement macro by its name, its arguments read off the
 * tokens, as are a `#define` inside a function's.
 */
export function readCpp(source: string): ParsedStructure {
  return readWithBranches(normalizeSource(source), true, read);
}

/** A function the walk found: its span and, as a call owner, the calls it makes and the lines it covers. */
interface Found extends CallOwner {
  span: Omit<ParsedFunctionSpan, "calls">;
}

function read(text: string, also?: string): ParsedStructure {
  let stream: Token[] = [];
  const { tree, errors } = parseWithAntlr(
    text,
    (input) => new CPP14Lexer(input),
    (tokens) => {
      const parser = new CPP14Parser(tokens);
      parser.prepare(tokens);
      stream = tokens.getTokens();
      return parser;
    },
    (parser) => parser.translationUnit(),
    // A file with an error is not read at all: core keeps the patterns' reading of it.
    { firstError: true },
  );
  if (!tree) return { functions: [], topLevelCalls: [], syntaxErrors: errors };
  const found = walk(tree, stream, text);
  defineCalls(stream, CPP_TOKENS, found);
  if (also) leftOutCalls(also, CPP_TOKENS, found);
  const functions = found.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) }));
  functions.sort((a, b) => a.line - b.line);
  return { functions, topLevelCalls: [], syntaxErrors: errors };
}

function walk(root: ParseTree, stream: readonly Token[], text: string): Found[] {
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
      if (!(ctx.parent instanceof PostfixExpressionContext && ctx.parent.children[0] === ctx)) postfixCalls(ctx, calls, text);
    } else if (calls && ctx instanceof PrimaryExpressionContext && ctx.MacroName()) {
      // `SIGNAL(moved(Club *))`: the macro is called, its arguments read off the tokens.
      const head = ctx.MacroName()!.symbol;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
      const args = ctx.macroArguments();
      if (args) macroArgumentCalls(args, stream, calls);
      continue;
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

/** The name a declarator declares, as the patterns name a definition: its last name, `~Club`, `operator==`. */
function declaredName(declarator: DeclaratorContext | null): { text: string; line: number } | null {
  let direct: NoPointerDeclaratorContext | null = declarator?.pointerDeclarator()?.noPointerDeclarator() ?? null;
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
      const named = byPattern === undefined ? nameCall(steps, CHAIN_DEPTH) : byPattern;
      if (named) calls.push(named);
      steps.push(callStep(steps));
    } else if (type === CPP14Lexer.Dot || type === CPP14Lexer.Arrow) {
      // The patterns read a member after `->` alone: `p->kick(` is `kick`.
      if (type === CPP14Lexer.Arrow) steps.push({ kind: "other", bare: true });
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

/** The first step of a chain: a name, `this` (whose members are named alone), or what no name spells. */
function headSteps(link: PostfixExpressionContext): CalleeStep[] {
  const primary = link.children[0];
  if (!(primary instanceof PrimaryExpressionContext)) return [{ kind: "other", bare: false }];
  const id = primary.idExpression();
  if (id) return idSteps(id);
  const head = primary.children[0];
  return [{ kind: "other", bare: head instanceof TerminalNode && head.symbol.type === CPP14Lexer.This }];
}

/** `new Club(…)`: the type is called, named as the patterns read `Club(`. */
function newCall(ctx: NewExpression_Context, calls: PatternCallName[], text: string): void {
  const init = ctx.newInitializer_();
  const type = ctx.newTypeId();
  if (!init || !type || init.start?.type !== CPP14Lexer.LeftParen || !type.start || !type.stop || type.stop.type !== CPP14Lexer.Identifier) return;
  const name = type.stop;
  const source = `${text.slice(type.start.start, init.start.start)}(`;
  const byPattern = patternNamedCall(source, cppSpec.callPatterns ?? [], type.start.line, type.start.column);
  const named = byPattern === undefined ? nameCall([idStep(name)], CHAIN_DEPTH) : byPattern;
  if (named) calls.push(named);
}
