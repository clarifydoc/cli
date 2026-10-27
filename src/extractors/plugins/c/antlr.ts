import { CharStream, Token, TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
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
  PostfixExpressionContext,
  PrimaryExpressionContext,
} from "../../../parsers/antlr/c/CParser.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { SPECIFIER_KEYWORDS } from "../../../parsers/antlr/c/CKeywords.js";
import { callStep, nameCall, type CalleeStep } from "../shared/callee-names.js";

/** How many calls deep a chain is named. */
const CHAIN_DEPTH = 8;

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
  const text = normalizeSource(source);
  const compiled = withoutDeadCode(text);
  const first = read(compiled);
  if (first.syntaxErrors === 0) return first;
  const branches = firstBranches(compiled);
  if (branches === compiled) return first;
  const second = read(branches, leftOut(compiled, branches));
  if (second.syntaxErrors > 0) return first;
  const others = secondBranches(compiled);
  if (others === branches) return second;
  const third = read(others);
  if (third.syntaxErrors > 0) return second;
  // A definition the first branches left out, and no function of theirs spans: not the same function's other header.
  const left = branches.split("\n");
  const added = third.functions.filter(
    (fn) => left[fn.line - 1]!.trim() === "" && !second.functions.some((kept) => kept.line <= fn.endLine && fn.line <= kept.endLine),
  );
  if (added.length === 0) return second;
  return { ...second, functions: [...second.functions, ...added].sort((a, b) => a.line - b.line) };
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
  defineCalls(stream, found);
  if (also) {
    const tokens = lexAll(also);
    defineCalls(tokens, found);
    for (const fn of found) tokenCalls(tokens.filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.line >= fn.from && t.line <= fn.to), fn.calls);
  }
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
        if (args?.start && args.stop) tokenCalls(stream.slice(args.start.tokenIndex, args.stop.tokenIndex + 1).filter((t) => t.channel === Token.DEFAULT_CHANNEL), calls);
      }
    }
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push({ node: ctx.children[i]!, owner: into });
  }
  return pending;
}

/** The tokens of `text`, on every channel. */
function lexAll(text: string): Token[] {
  const lexer = new CLexer(CharStream.fromString(text));
  lexer.removeErrorListeners();
  return lexer.getAllTokens();
}

/** A `#define`'s name and parameters, before its body: `#define RND(a, b) \`. */
const DEFINE_HEAD = /^#\s*define\s+[A-Za-z_$][\w$]*(?:\([^)]*\))?/;

/** The calls of each `#define` written inside a function, which the function makes where it uses the macro. */
function defineCalls(tokens: readonly Token[], found: readonly Found[]): void {
  for (const t of tokens) {
    if (t.type !== CLexer.Directive && t.type !== CLexer.MultiLineMacro) continue;
    const fn = found.find((f) => t.line >= f.from && t.line <= f.to);
    if (!fn) continue;
    const text = t.text ?? "";
    const head = DEFINE_HEAD.exec(text);
    if (!head) continue;
    // The body lexed in place: blank the head so lines and columns stay the file's.
    const body = "\n".repeat(t.line - 1) + " ".repeat(t.column + head[0].length) + text.slice(head[0].length).replace(/\\\r?\n/g, " \n");
    tokenCalls(lexAll(body).filter((b) => b.channel === Token.DEFAULT_CHANNEL), fn.calls);
  }
}

/**
 * The calls a run of tokens makes, named as `postfixCalls` names them: `f(`, `a.b(`, a member after `->` alone. A
 * name after a type or another name (`int f(`, `T f(`) declares a function rather than calling one.
 */
function tokenCalls(tokens: readonly Token[], calls: PatternCallName[]): void {
  let steps: CalleeStep[] = [];
  let before = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const prev = tokens[i - 1]?.type ?? -1;
    if (t.type === CLexer.Identifier) {
      if (prev === CLexer.Dot || prev === CLexer.Arrow) {
        // A member of what no name spells (`).x(`) is named only after `->`, as the patterns read it.
        if (steps.length === 0) {
          steps = [{ kind: "other", bare: prev === CLexer.Arrow }];
          before = -1;
        } else if (prev === CLexer.Arrow) steps.push({ kind: "other", bare: true });
        steps.push(idStep(t));
      } else {
        steps = [idStep(t)];
        before = prev;
      }
    } else if (t.type !== CLexer.Dot && t.type !== CLexer.Arrow) {
      if (t.type === CLexer.LeftParen && steps.at(-1)?.kind === "id" && !(before === CLexer.Identifier || SPECIFIER_KEYWORDS.has(before))) {
        const named = nameCall(steps, CHAIN_DEPTH);
        if (named) calls.push(named);
      }
      steps = [];
    }
  }
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

/** The directive a line holds, its continuation lines (`\` at the end) joined. */
const DIRECTIVE = /^\s*#\s*(if|ifdef|ifndef|elif|elifdef|elifndef|else|endif)\b(.*)$/;

/** A condition no C compiler takes: `#if 0`, `#ifdef __cplusplus`, `#if defined(__cplusplus)`. */
function deadCondition(kind: string, rest: string): boolean {
  const cond = rest.trim();
  if (kind === "if") return cond === "0" || /^\(\s*0\s*\)$/.test(cond) || /^defined\s*\(?\s*__cplusplus\s*\)?$/.test(cond) || cond === "__cplusplus";
  if (kind === "ifdef") return cond === "__cplusplus";
  return false;
}

/** A conditional the text is in: which of its `count` branches, and whether its first is `dead`. */
interface Frame {
  branch: number;
  count: number;
  dead: boolean;
}

/**
 * The text with conditional branches blanked out, lines and columns kept. A frame's first branch is `dead` when no C
 * compiler takes it (`#if 0`); `keep(frame)` says whether the branch a line is in stays.
 */
function blankBranches(text: string, keep: (frame: Frame) => boolean): string {
  const lines = text.split("\n");
  // How many branches each conditional has, in the order they open.
  const counts: number[] = [];
  const open: number[] = [];
  for (const line of lines) {
    const kind = DIRECTIVE.exec(line)?.[1];
    if (kind === "if" || kind === "ifdef" || kind === "ifndef") open.push(counts.push(1) - 1);
    else if (kind === "endif") open.pop();
    else if (kind && open.length > 0) counts[open.at(-1)!]!++;
  }
  const frames: Frame[] = [];
  let opened = 0;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE.exec(lines[i]!);
    if (m) {
      const kind = m[1]!;
      if (kind === "if" || kind === "ifdef" || kind === "ifndef") frames.push({ branch: 0, count: counts[opened++]!, dead: deadCondition(kind, m[2]!) });
      else if (kind === "endif") frames.pop();
      else if (frames.length > 0) frames.at(-1)!.branch++;
      while (lines[i]!.endsWith("\\") && i + 1 < lines.length) i++;
      continue;
    }
    if (frames.length > 0 && !frames.every(keep)) {
      lines[i] = lines[i]!.replace(/\S/g, " ");
      changed = true;
    }
  }
  return changed ? lines.join("\n") : text;
}

/** `#if 0` and `#ifdef __cplusplus` blocks blanked, their `#else` kept. */
function withoutDeadCode(text: string): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, (f) => !(f.dead && f.branch === 0));
}

/** The lines of `compiled` that `read` blanked, the rest blank: the branches a reading of `read` leaves out. */
function leftOut(compiled: string, read: string): string {
  const kept = read.split("\n");
  return compiled
    .split("\n")
    .map((line, i) => (kept[i]!.trim() === "" && line.trim() !== "" ? line : ""))
    .join("\n");
}

/** Only the first branch of every conditional kept (the live one after a dead `#if 0`). */
function firstBranches(text: string): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, (f) => f.branch === (f.dead ? 1 : 0));
}

/** Only the second branch of every conditional kept, or its only one: what an `#else` defines for another platform. */
function secondBranches(text: string): string {
  if (!text.includes("#")) return text;
  return blankBranches(text, (f) => f.branch === (f.dead ? 1 : Math.min(1, f.count - 1)));
}
