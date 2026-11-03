import { TerminalNode, type ParserRuleContext, type ParseTree, type Token } from "antlr4ng";
import type { CallInfo } from "../../../types/analysis.js";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { GoLexer } from "../../../parsers/antlr/go/GoLexer.js";
import {
  GoParser,
  ArgumentsContext,
  DeclarationContext,
  FunctionDeclContext,
  FunctionLitContext,
  IdentifierListContext,
  MethodDeclContext,
  OperandContext,
  PrimaryExprContext,
  TypeArgsContext,
  TypeSwitchGuardContext,
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
      functions.push({ name: name.text ?? "", line: child.start!.line, endLine, calls: withPassedValues(recordPatternCalls(found), [child]) });
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
  return { name: name.text ?? "", line: name.line, endLine: spec.stop?.line ?? name.line, calls: withPassedValues(recordPatternCalls(found), literals) };
}

/**
 * `calls` with the method values `roots` hand on as arguments — `Wrap(h.Health)`, `s.Use(s.handler.Middleware)`,
 * `consume(h.Kickoff)` — each a `passed: "argument"` name spelled as a call of it would be (`h.Health`,
 * `handler.Middleware`). Only a selector on a value the function declares — its receiver, a parameter, a local —
 * names one: a bare identifier is a value, a package member (`handlers.New`) is no method value, and an index or a
 * call's result in the path (`h.Get().X`) names nothing. A name the function also calls is a call already.
 */
function withPassedValues(calls: CallInfo[], roots: readonly ParserRuleContext[]): CallInfo[] {
  const bound = new Set<string>();
  for (const root of roots) declaredNames(root, bound);
  if (bound.size === 0) return calls;
  const invoked = new Set(calls.map((c) => c.name));
  // Appended in place: the recorder keeps the stdlib-noise calls it held back by this array and their positions in it.
  const out = calls;
  for (const root of roots) {
    const stack: ParseTree[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node instanceof TerminalNode) continue;
      const ctx = node as ParserRuleContext;
      if (ctx instanceof ArgumentsContext && !takesValuesOnly(ctx)) {
        for (const arg of ctx.expressionList()?.expression() ?? []) {
          const value = arg.children.length === 1 && arg.children[0] instanceof PrimaryExprContext ? methodValue(arg.children[0], bound) : null;
          if (!value || invoked.has(value.name)) continue;
          invoked.add(value.name);
          out.push({ name: value.name, kind: "internal", target: null, line: value.line, column: value.column, passed: "argument" });
        }
      }
      for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
    }
  }
  return out;
}

/** Built-ins and conversions to a basic type: they read their arguments, never run one. */
const VALUE_BUILTINS: ReadonlySet<string> = new Set([
  "len", "cap", "make", "new", "delete", "copy", "clear", "close", "min", "max", "print", "println", "panic",
  "complex", "real", "imag", "string", "bool", "byte", "rune", "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64",
]);

/** Standard packages none of whose functions takes a function: formatting, logging, errors, number parsing. */
const VALUE_PACKAGES: ReadonlySet<string> = new Set(["fmt", "log", "slog", "errors", "strconv"]);

/** Whether the call these arguments belong to is a built-in (`len(x.Items)`) or a function of a `VALUE_PACKAGES` package. */
function takesValuesOnly(args: ArgumentsContext): boolean {
  const primary = args.parent;
  if (!(primary instanceof PrimaryExprContext)) return false;
  const at = primary.children.indexOf(args);
  const head = primary.children[0] instanceof OperandContext ? primary.children[0].operandName()?.IDENTIFIER().getText() : undefined;
  if (!head) return false;
  if (at === 1) return VALUE_BUILTINS.has(head);
  return at === 3 && VALUE_PACKAGES.has(head);
}

/** `h.Health` or `s.handler.Health` — a name, then one or two members, nothing else — on a declared head. */
function methodValue(primary: PrimaryExprContext, bound: ReadonlySet<string>): PatternCallName | null {
  const [operand, ...rest] = primary.children;
  if (!(operand instanceof OperandContext) || operand.children.length !== 1) return null;
  const head = operand.operandName()?.IDENTIFIER().symbol;
  if (!head || !bound.has(head.text ?? "") || rest.length < 2 || rest.length > 4) return null;
  const segments: CalleeSegment[] = [idOf(head)];
  for (let i = 0; i < rest.length; i += 2) {
    const dot = rest[i];
    const member = rest[i + 1];
    if (!(dot instanceof TerminalNode) || dot.symbol.type !== GoLexer.DOT) return null;
    if (!(member instanceof TerminalNode) || member.symbol.type !== GoLexer.IDENTIFIER) return null;
    segments.push(idOf(member.symbol));
  }
  return patternCallName(segments, 0);
}

/** The names a function binds — receiver, parameters, results, locals, range and type-switch variables — into `out`. */
function declaredNames(root: ParserRuleContext, out: Set<string>): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    if (node instanceof IdentifierListContext) {
      for (const id of node.IDENTIFIER()) if (id.getText() !== "_") out.add(id.getText());
    } else if (node instanceof TypeSwitchGuardContext) {
      const id = node.IDENTIFIER();
      if (id) out.add(id.getText());
    }
    const ctx = node as ParserRuleContext;
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
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
