import { TerminalNode, type ParserRuleContext, type ParseTree, type Token } from "antlr4ng";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { GoLexer } from "../../../parsers/antlr/go/GoLexer.js";
import {
  GoParser,
  ArgumentsContext,
  DeclarationContext,
  FunctionDeclContext,
  FunctionLitContext,
  MethodDeclContext,
  OperandContext,
  PrimaryExprContext,
  TypeArgsContext,
  VarSpecContext,
} from "../../../parsers/antlr/go/GoParser.js";
import { parseWithAntlr } from "../../../parsers/antlr/run.js";
import { patternCallName, recordPatternCalls, type CalleeSegment, type PatternCallName } from "../shared/antlr-calls.js";

/** As deep as the Go spec's `callChainPatterns` read a chain. */
const CHAIN_DEPTH = 3;

/**
 * Go's functions and calls as the grammars-v4 Go grammar reads them (the `antlr:go` feature). A function is
 * a top-level `func` declaration — a method too, which the spec's `extractClasses` attaches to its
 * receiver — spanning `func` to its closing brace, or a package-level function variable (`varFunction`); any
 * other function literal is part of the declaration that holds it, as on the regex path. Calls outside every
 * function — package-level initializers — are the file's `<setup>`. A call is an argument list applied to a
 * primary expression, named as the regex scan names it (`patternCallName`).
 */
export function readGo(source: string): ParsedStructure {
  const { tree, errors } = parseWithAntlr(
    source,
    (input) => new GoLexer(input),
    (tokens) => new GoParser(tokens),
    (parser) => parser.sourceFile(),
  );
  const functions: ParsedFunctionSpan[] = [];
  const topLevel: PatternCallName[] = [];
  for (const child of tree.children) {
    if (child instanceof FunctionDeclContext || child instanceof MethodDeclContext) {
      const name = child.IDENTIFIER()?.symbol;
      if (!name) continue;
      const found: PatternCallName[] = [];
      collectCalls(child, found);
      // A declaration ends at its body's `}`, or at its signature when it has none.
      const endLine = child.stop?.line ?? child.start!.line;
      functions.push({ name: name.text ?? "", line: child.start!.line, endLine, calls: recordPatternCalls(found) });
    } else if (child instanceof DeclarationContext && child.varDecl()) {
      for (const spec of child.varDecl()!.varSpec()) {
        const fn = varFunction(spec, topLevel);
        if (fn) functions.push(fn);
      }
    } else if (!(child instanceof TerminalNode)) {
      collectCalls(child as ParserRuleContext, topLevel);
    }
  }
  return { functions, topLevelCalls: recordPatternCalls(topLevel), syntaxErrors: errors };
}

/**
 * A package-level function variable — `var saveClub = func(name string) { … }`, or a literal its initializer hands on
 * (`var handler = http.HandlerFunc(func(w, r) { … })`): a function named for the var, spanning the spec, whose calls
 * are those of its literals. The initializer's own calls (`http.HandlerFunc`) run at package init and go to `out`,
 * as does every call of a spec that binds no such literal: one binding several names, the blank `_`, or a literal
 * invoked on the spot (`var cfg = func() Config { … }()`).
 */
function varFunction(spec: VarSpecContext, out: PatternCallName[]): ParsedFunctionSpan | null {
  const names = spec.identifierList().IDENTIFIER();
  const values = spec.expressionList()?.expression() ?? [];
  const name = names.length === 1 && values.length === 1 ? names[0]!.symbol : null;
  const literals = name && name.text !== "_" ? functionLiterals(values[0]!) : [];
  if (!name || literals.length === 0) {
    collectCalls(spec, out);
    return null;
  }
  collectCalls(spec, out, new Set(literals));
  const found: PatternCallName[] = [];
  for (const literal of literals) collectCalls(literal, found);
  return { name: name.text ?? "", line: name.line, endLine: spec.stop?.line ?? name.line, calls: recordPatternCalls(found) };
}

/** The function literals of an initializer that are not invoked where they are written (outermost only). */
function functionLiterals(root: ParserRuleContext): FunctionLitContext[] {
  const out: FunctionLitContext[] = [];
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    if (node instanceof FunctionLitContext) {
      if (!invokedInPlace(node)) out.push(node);
      continue;
    }
    const ctx = node as ParserRuleContext;
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
  return out;
}

/** `func() { … }()`: the literal is the operand of a primary expression whose next step is an argument list. */
function invokedInPlace(literal: FunctionLitContext): boolean {
  let node: ParserRuleContext | null = literal.parent;
  while (node && !(node instanceof OperandContext)) {
    if (node instanceof PrimaryExprContext) return false;
    node = node.parent;
  }
  const primary = node?.parent;
  return primary instanceof PrimaryExprContext && primary.children[0] === node && primary.children[1] instanceof ArgumentsContext;
}

function collectCalls(root: ParserRuleContext, out: PatternCallName[], skip?: ReadonlySet<ParseTree>): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode || skip?.has(node)) continue;
    const ctx = node as ParserRuleContext;
    if (ctx instanceof PrimaryExprContext) callsOfPrimary(ctx, out);
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
}

/** `primaryExpr: (operand | conversion) (. IDENTIFIER typeArgs? | index | slice | typeAssertion | arguments)*`. */
function callsOfPrimary(ctx: PrimaryExprContext, out: PatternCallName[]): void {
  const children = ctx.children;
  if (children.length < 2) return;
  const segments: CalleeSegment[] = baseSegments(children[0]!);
  for (let i = 1; i < children.length; i++) {
    const child = children[i]!;
    if (child instanceof TerminalNode) {
      // `. IDENTIFIER`: the dot, then the member.
      if (child.symbol.type === GoLexer.IDENTIFIER) segments.push(idOf(child.symbol));
      continue;
    }
    // `lru.New[string, *Item](n)` calls `lru.New`.
    if (child instanceof TypeArgsContext) continue;
    if (child instanceof ArgumentsContext) {
      const named = patternCallName(segments, CHAIN_DEPTH);
      if (named) out.push(named);
      segments.push({ kind: "call" });
      continue;
    }
    segments.push({ kind: "other" });
  }
}

function idOf(token: Token): CalleeSegment {
  return { kind: "id", name: token.text ?? "", line: token.line, column: token.column };
}

/** The name a primary expression starts with (`x`, `pkg` of `pkg.Fn`); anything else names nothing. */
function baseSegments(base: ParseTree): CalleeSegment[] {
  const name = base instanceof OperandContext ? base.operandName()?.IDENTIFIER().symbol : undefined;
  return name ? [idOf(name)] : [{ kind: "other" }];
}
