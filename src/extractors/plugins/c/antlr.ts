import { Token, TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { CLexer } from "../../../parsers/antlr/c/CLexer.js";
import {
  CParser,
  DeclaratorContext,
  DirectDeclaratorContext,
  FunctionDefinitionContext,
  MacroAttributeContext,
  MacroBlockStatementContext,
  MacroStatementContext,
  MacroFunctionDefinitionContext,
  StringMacroContext,
  PostfixExpressionContext,
  PrimaryExpressionContext,
} from "../../../parsers/antlr/c/CParser.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { SPECIFIER_KEYWORDS } from "../../../parsers/antlr/c/CKeywords.js";
import { callStep, nameCall, type CalleeStep } from "../shared/callee-names.js";
import { readWithBranches } from "../shared/preprocessor-branches.js";
import { defineCalls, leftOutCalls, tokenCalls, type TokenKinds } from "../shared/token-calls.js";

/** How many calls deep a chain is named. */
const CHAIN_DEPTH = 8;

/** C's tokens, for the calls read off them. */
const C_TOKENS: TokenKinds = {
  identifier: CLexer.Identifier,
  dot: CLexer.Dot,
  arrow: CLexer.Arrow,
  leftParen: CLexer.LeftParen,
  directives: new Set([CLexer.Directive, CLexer.MultiLineMacro]),
  declares: SPECIFIER_KEYWORDS,
  lexer: (input) => new CLexer(input),
};

/**
 * C's functions and calls as the grammars-v4 C grammar reads them, in two passes (`parsers/antlr/c/CTypes.ts`): the
 * names the file uses as types first, then the parse, whose predicates read them as typedef names — what `gcc -E`
 * and the headers would have told a compiler. Code no C compiler sees (`#if 0`, `#ifdef __cplusplus`) is left out;
 * when the file as written does not parse, it is read again with only the first branch of every `#if`/`#else`, as a
 * function whose header differs per platform is written twice before one body. The calls of the branches that reading
 * leaves out still count, as the patterns count them, read off their tokens; the functions they define (another
 * platform's `#else`) come from a reading of every conditional's second branch, when that one parses too.
 *
 * A function is a definition, named by its declarator (through `(*name(…))`) on that name's line, as the patterns
 * place it, and owns the calls in its body. A call is named as the C patterns name it: `f(` is `f`, `a.b(` is `a.b`,
 * a member after `->` alone (`p->ops->read(` is `read`), a statement macro by its name (`foreach(list, i) {`); a
 * method on a call's result is the chain from its first call. What the grammar reads as no expression is read off
 * its tokens the same way (`tokenCalls`): a macro's arguments (`expect_cond("x", cmp(a, b) > 0)`) and a `#define`
 * inside a function, whose calls the function makes where it uses the macro.
 */
export function readC(source: string): ParsedStructure {
  return readWithBranches(normalizeSource(source), false, read);
}

/** A function the walk found: its span, the calls it makes so far, and the lines its definition covers. */
interface Found {
  span: Omit<ParsedFunctionSpan, "calls">;
  calls: PatternCallName[];
  from: number;
  to: number;
}

/** Reads `text`; `also` is code the reading leaves out, lines in place, whose calls go to the function around them. */
function read(text: string, also?: string): ParsedStructure {
  let stream: Token[] = [];
  const { tree, errors } = parseWithAntlr(
    text,
    (input) => new CLexer(input),
    (tokens) => {
      const parser = new CParser(tokens);
      parser.prepare(tokens);
      stream = tokens.getTokens();
      return parser;
    },
    (parser) => parser.compilationUnit(),
    // A file with an error is not read at all: core keeps the patterns' reading of it.
    { firstError: true },
  );
  if (!tree) return { functions: [], topLevelCalls: [], syntaxErrors: errors };
  const found = walk(tree, stream);
  defineCalls(stream, C_TOKENS, found);
  if (also) leftOutCalls(also, C_TOKENS, found);
  const functions = found.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) }));
  functions.sort((a, b) => a.line - b.line);
  return { functions, topLevelCalls: [], syntaxErrors: errors };
}

function walk(root: ParseTree, stream: readonly Token[]): Found[] {
  const stack: Array<{ node: ParseTree; owner: PatternCallName[] | null }> = [{ node: root, owner: null }];
  const pending: Found[] = [];
  while (stack.length > 0) {
    const { node, owner: calls } = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    let into = calls;
    if (ctx instanceof FunctionDefinitionContext) {
      const name = declaredName(ctx.declarator());
      into = [];
      const endLine = ctx.stop?.line ?? name?.line ?? ctx.start!.line;
      if (name) pending.push({ span: { name: name.text, line: name.line, endLine }, calls: into, from: ctx.start!.line, to: endLine });
    } else if (ctx instanceof MacroFunctionDefinitionContext) {
      // `MATCH_TEST(kickoff) { … }`: a function named by the macro; its arguments name it, they call nothing.
      const head = (ctx.children[0] as TerminalNode).symbol;
      const endLine = ctx.stop?.line ?? head.line;
      into = [];
      pending.push({ span: { name: head.text ?? "", line: head.line, endLine }, calls: into, from: head.line, to: endLine });
      stack.push({ node: ctx.compoundStatement(), owner: into });
      continue;
    } else if (calls && ctx instanceof StringMacroContext && ctx.gnuAttributeList()) {
      // `"x" QUOTE(n) "y"`: a macro called among strings.
      const head = (ctx.children[0] as TerminalNode).symbol;
      calls.push({ name: head.text ?? "", leafName: head.text ?? "", line: head.line, column: head.column });
    } else if (calls && ctx instanceof PostfixExpressionContext) {
      postfixCalls(ctx, calls);
    } else if (calls && (ctx instanceof MacroBlockStatementContext || ctx instanceof MacroStatementContext || ctx instanceof MacroAttributeContext)) {
      // `foreach(list, i) { … }`, `VERBOSE(char buf[N]);`, `IGNORE_DEPRECATION(…) x = f();` in a body: the macro is
      // called by its name.
      const head = ctx.children[0];
      if (head instanceof TerminalNode && head.symbol.type === CLexer.Identifier) {
        calls.push({ name: head.symbol.text ?? "", leafName: head.symbol.text ?? "", line: head.symbol.line, column: head.symbol.column });
        // Its arguments are tokens to the grammar: `expect_cond("x", cmp(a, b) > 0)`.
        const args = (ctx as MacroBlockStatementContext | MacroStatementContext | MacroAttributeContext).gnuAttributeList();
        if (args?.start && args.stop) tokenCalls(stream.slice(args.start.tokenIndex, args.stop.tokenIndex + 1).filter((t) => t.channel === Token.DEFAULT_CHANNEL), C_TOKENS, calls);
      }
    }
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push({ node: ctx.children[i]!, owner: into });
  }
  return pending;
}

/** The name a declarator declares: its direct declarator's identifier, through parentheses (`(*signal(int))(int)`). */
function declaredName(declarator: DeclaratorContext | null): { text: string; line: number } | null {
  let direct: DirectDeclaratorContext | null = declarator?.directDeclarator() ?? null;
  while (direct) {
    const id = direct.Identifier();
    if (id) return { text: id.symbol.text ?? "", line: id.symbol.line };
    direct = direct.declarator()?.directDeclarator() ?? null;
  }
  return null;
}

const idStep = (token: { text?: string | undefined; line: number; column: number }): CalleeStep => ({
  kind: "id",
  name: token.text ?? "",
  line: token.line,
  column: token.column,
});

/** The calls a postfix expression makes: each `(…)` calls what comes before it. */
function postfixCalls(ctx: PostfixExpressionContext, calls: PatternCallName[]): void {
  const steps: CalleeStep[] = [];
  const children = ctx.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (child instanceof PrimaryExpressionContext) {
      const head = child.children[0];
      steps.push(child.children.length === 1 && head instanceof TerminalNode && head.symbol.type === CLexer.Identifier ? idStep(head.symbol) : { kind: "other", bare: false });
      continue;
    }
    if (!(child instanceof TerminalNode)) continue;
    const type = child.symbol.type;
    if (type === CLexer.LeftParen && steps.length > 0) {
      const named = nameCall(steps, CHAIN_DEPTH);
      if (named) calls.push(named);
      steps.push(callStep(steps));
      while (i < children.length && !(children[i] instanceof TerminalNode && (children[i] as TerminalNode).symbol.type === CLexer.RightParen)) i++;
    } else if (type === CLexer.Dot || type === CLexer.Arrow) {
      const member = children[i + 1];
      // The patterns read a member after `->` alone: `p->fn(` is `fn`.
      if (type === CLexer.Arrow) steps.push({ kind: "other", bare: true });
      if (member instanceof TerminalNode) steps.push(idStep(member.symbol));
      i++;
    } else if (type === CLexer.LeftBracket) {
      steps.push({ kind: "other", bare: false });
      while (i < children.length && !(children[i] instanceof TerminalNode && (children[i] as TerminalNode).symbol.type === CLexer.RightBracket)) i++;
    } else if (steps.length === 0) {
      steps.push({ kind: "other", bare: false });
    }
  }
}
