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
  ParametersContext,
  PrimaryExprContext,
  RangeClauseContext,
  ShortVarDeclContext,
  StructTypeContext,
  InterfaceTypeContext,
  TypeArgsContext,
  TypeSwitchGuardContext,
  VarSpecContext,
} from "../../../parsers/antlr/go/GoParser.js";
import { parseWithAntlr } from "../../../parsers/antlr/run.js";
import { patternCallName, recordPatternCalls, type CalleeSegment, type PatternCallName } from "../shared/antlr-calls.js";
import type { ValueFlowFact } from "../../../types/analysis.js";
import { goFlowFileFacts, goValueFlow, type GoFlowEnv } from "./value-flow.js";

/**
 * The Go lexer, retyping the `(` after a callee named `make` or `new` as `MakeParen` / `NewParen` (the grammar's
 * `arguments` rule reads them as the built-ins' argument lists). Decided here, from the token before, rather than by
 * a predicate in the parser: a predicate looking back at tokens before its decision is one the parser's shared
 * prediction cache may answer from another file's parse.
 */
class GoReadLexer extends GoLexer {
  private callee: Token | null = null;

  override nextToken(): Token {
    const token = super.nextToken();
    if (token.channel !== 0) return token;
    if (token.type === GoLexer.L_PAREN && this.callee?.type === GoLexer.IDENTIFIER) {
      const name = this.callee.text;
      if (name === "make") token.type = GoLexer.MakeParen;
      else if (name === "new") token.type = GoLexer.NewParen;
    }
    this.callee = token;
    return token;
  }
}

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
    (input) => new GoReadLexer(input),
    (tokens) => new GoParser(tokens),
    (parser) => parser.sourceFile(),
  );
  const functions: ParsedFunctionSpan[] = [];
  const topLevel: PatternCallName[] = [];
  const moduleValueFlow: ValueFlowFact[] = [];
  const env = flowEnv(tree);
  for (const child of tree.children) {
    if (child instanceof FunctionDeclContext || child instanceof MethodDeclContext) {
      const name = child.IDENTIFIER()?.symbol;
      if (!name) continue;
      const found: PatternCallName[] = [];
      const scope = callScope([child], child instanceof MethodDeclContext ? child.receiver() : undefined);
      collectCalls(child, found, undefined, scope);
      // A declaration ends at its body's `}`, or at its signature when it has none.
      const endLine = child.stop?.line ?? child.start!.line;
      const span: ParsedFunctionSpan = { name: name.text ?? "", line: child.start!.line, endLine, calls: withPassedValues(recordPatternCalls(found), [child]) };
      addValueFlow(span, [child], scope, env, moduleValueFlow);
      functions.push(span);
    } else if (child instanceof DeclarationContext && child.varDecl()) {
      for (const spec of child.varDecl()!.varSpec()) {
        const fn = varFunction(spec, topLevel, env, moduleValueFlow);
        if (fn) functions.push(fn);
      }
    } else if (!(child instanceof TerminalNode)) {
      collectCalls(child as ParserRuleContext, topLevel);
    }
  }
  return { functions, topLevelCalls: recordPatternCalls(topLevel), syntaxErrors: errors, ...(moduleValueFlow.length > 0 ? { moduleValueFlow } : {}) };
}

/** What the value-flow reading needs of the whole file: package variables, function types and function-typed fields. */
function flowEnv(tree: ParserRuleContext): GoFlowEnv {
  const packageVars = new Set<string>();
  for (const child of tree.children) {
    if (!(child instanceof DeclarationContext) || !child.varDecl()) continue;
    for (const spec of child.varDecl()!.varSpec()) {
      const names = spec.identifierList().IDENTIFIER();
      const values = spec.expressionList()?.expression() ?? [];
      const isFunction = names.length === 1 && values.length === 1 && names[0]!.getText() !== "_" && functionLiterals(values[0]!).length > 0;
      if (!isFunction) for (const id of names) packageVars.add(id.getText());
    }
  }
  const { funcFields, funcTypes } = goFlowFileFacts(tree);
  return { applications: (ctx) => applications(ctx, undefined), packageVars, funcFields, funcTypes };
}

/**
 * The function-value facts of `roots` onto `span`; those of a package variable assigned in it join `module`. Names the
 * roots declare are theirs; a method's receiver is `this`.
 */
function addValueFlow(span: ParsedFunctionSpan, roots: readonly ParserRuleContext[], scope: CallScope, env: GoFlowEnv, module: ValueFlowFact[]): void {
  const bound = new Map<string, Array<readonly [number, number]>>();
  for (const root of roots) boundPositions(root, bound);
  if (scope.receiver) bound.delete(scope.receiver);
  const applicationsIn = (ctx: PrimaryExprContext): ReturnType<GoFlowEnv["applications"]> => applications(ctx, scope);
  const { facts, moduleFacts } = goValueFlow(roots, { ...(scope.receiver ? { receiver: scope.receiver } : {}), bound, env: { ...env, applications: applicationsIn } });
  if (facts.length > 0) span.valueFlow = facts;
  module.push(...moduleFacts);
}

/**
 * A package-level function variable — `var saveClub = func(name string) { … }`, or a literal its initializer hands on
 * (`var handler = http.HandlerFunc(func(w, r) { … })`): a function named for the var, spanning the spec, whose calls
 * are those of its literals. The initializer's own calls (`http.HandlerFunc`) run at package init and go to `out`,
 * as does every call of a spec that binds no such literal: one binding several names, the blank `_`, or a literal
 * invoked on the spot (`var cfg = func() Config { … }()`).
 */
function varFunction(spec: VarSpecContext, out: PatternCallName[], env: GoFlowEnv, module: ValueFlowFact[]): ParsedFunctionSpan | null {
  const names = spec.identifierList().IDENTIFIER();
  const values = spec.expressionList()?.expression() ?? [];
  const name = names.length === 1 && values.length === 1 ? names[0]!.symbol : null;
  const literals = name && name.text !== "_" ? functionLiterals(values[0]!) : [];
  if (!name || literals.length === 0) {
    collectCalls(spec, out);
    // A package variable's initializer states its own value flow, at module scope.
    module.push(...goValueFlow([spec], { bound: new Map(), env, moduleLevel: true }).moduleFacts);
    return null;
  }
  collectCalls(spec, out, new Set(literals));
  const found: PatternCallName[] = [];
  const scope = callScope(literals);
  for (const literal of literals) collectCalls(literal, found, undefined, scope);
  const span: ParsedFunctionSpan = { name: name.text ?? "", line: name.line, endLine: spec.stop?.line ?? name.line, calls: withPassedValues(recordPatternCalls(found), literals) };
  addValueFlow(span, literals, scope, env, module);
  return span;
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

/**
 * The names a function binds with the place each binding takes effect: a declaring statement's end for a short
 * declaration, `var` spec or `range` clause (the scope starts after it, so `pool := pool()` still calls the
 * function), the function's start for a parameter, receiver or type-switch variable.
 */
function boundPositions(root: ParserRuleContext, out: Map<string, Array<readonly [number, number]>>): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    // A struct's fields and an interface's methods are no names the function binds (a table test's
    // `[]struct{ newBackend func(…) }` leaves the package's `newBackend` callable by name).
    if (node instanceof TerminalNode || node instanceof StructTypeContext || node instanceof InterfaceTypeContext) continue;
    const add = (name: string, from: readonly [number, number]): void => {
      if (name === "_") return;
      const list = out.get(name);
      if (list) list.push(from);
      else out.set(name, [from]);
    };
    if (node instanceof IdentifierListContext) {
      const owner = node.parent;
      const end = owner instanceof ShortVarDeclContext || owner instanceof VarSpecContext || owner instanceof RangeClauseContext ? owner.stop : null;
      for (const id of node.IDENTIFIER()) add(id.getText(), end ? [end.line, end.column + (end.text?.length ?? 1)] : [0, 0]);
    } else if (node instanceof TypeSwitchGuardContext) {
      const id = node.IDENTIFIER();
      if (id) add(id.getText(), [0, 0]);
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

/** The values a function's calls are named from: the names its signatures declare with a type, and its receiver's. */
interface CallScope {
  typed: ReadonlySet<string>;
  receiver?: string;
  /** Names the body declares (short declaration, `var`, `range`), each with where its scope starts (line, column). */
  locals: ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;
}

/** The receiver and parameters of `roots` and of the function literals in them, and the locals they declare. */
function callScope(roots: readonly ParserRuleContext[], receiver?: ParserRuleContext): CallScope {
  const typed = new Set<string>();
  const stack: ParseTree[] = [...roots];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    if (node instanceof ParametersContext) declaredNames(node, typed);
    const ctx = node as ParserRuleContext;
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
  const own = new Set<string>();
  if (receiver) declaredNames(receiver, own);
  const locals = new Map<string, Array<readonly [number, number]>>();
  for (const root of roots) {
    const bound = new Map<string, Array<readonly [number, number]>>();
    boundPositions(root, bound);
    for (const [name, at] of bound) {
      const starts = at.filter(([line]) => line > 0);
      if (starts.length > 0) locals.set(name, [...(locals.get(name) ?? []), ...starts]);
    }
  }
  return { typed, locals, ...(own.size === 1 ? { receiver: [...own][0]! } : {}) };
}

/**
 * A member called through fields of a value whose type the function states — its receiver or a parameter —, named by
 * every name back to that value: `h.Module.Clubs.Promote(` is `h.Module.Clubs.Promote`, so the linker types the
 * receiver from `h` field by field. Its last two names (`Clubs.Promote`) would say the caller's own field `Clubs`,
 * which a value two fields away is not. A local is a head too — `for _, c := range clubs { c.Status.String() }` is
 * `c.Status.String`, the local `c` typed by its range element (`localTypes`), so is `x := m.Club(); x.League.Close()`;
 * only from where its declaration ends, since the scope starts after it. The receiver's own field (`s.repo.Find(`,
 * read as `repo.Find`), a package's member and a path split over lines (whose text the argument readers look the
 * name up by) keep the scan's name, marked `receiverCut`: its first name is a field or a package value, never a class.
 */
function pathFromHead(segments: readonly CalleeSegment[], scope: CallScope | undefined): PatternCallName | null {
  if (!scope || segments.length < 3 || !segments.every((s) => s.kind === "id" && !s.colon)) return null;
  const ids = segments as ReadonlyArray<Extract<CalleeSegment, { kind: "id" }>>;
  const head = ids[0]!;
  const last = ids.at(-1)!;
  const local = scope.locals.get(head.name)?.some(([line, column]) => head.line > line || (head.line === line && head.column >= column));
  if (!(scope.typed.has(head.name) || local) || (ids.length === 3 && head.name === scope.receiver)) return null;
  if (ids.some((s) => s.line !== head.line)) return null;
  // A local states no type the way a parameter does: its two-name reading stays the fallback (`CallInfo.fallbackName`).
  const fallback = !scope.typed.has(head.name) ? patternCallName(segments, CHAIN_DEPTH)?.name : undefined;
  return { name: ids.map((s) => s.name).join("."), leafName: last.name, line: head.line, column: head.column, ...(fallback ? { fallbackName: fallback } : {}) };
}

function collectCalls(root: ParserRuleContext, out: PatternCallName[], skip?: ReadonlySet<ParseTree>, scope?: CallScope): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode || skip?.has(node)) continue;
    const ctx = node as ParserRuleContext;
    if (ctx instanceof PrimaryExprContext) callsOfPrimary(ctx, out, scope);
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
}

/** `primaryExpr: (operand | conversion) (. IDENTIFIER typeArgs? | index | slice | typeAssertion | arguments)*`. */
function callsOfPrimary(ctx: PrimaryExprContext, out: PatternCallName[], scope?: CallScope): void {
  for (const { named } of applications(ctx, scope)) if (named) out.push(named);
}

/** Each argument list of a primary expression (its index among the children) with the name the call is given, or null. */
function applications(ctx: PrimaryExprContext, scope?: CallScope): Array<{ at: number; named: PatternCallName | null }> {
  const children = ctx.children;
  const found: Array<{ at: number; named: PatternCallName | null }> = [];
  if (children.length < 2) return found;
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
      found.push({ at: i, named: pathFromHead(segments, scope) ?? cutName(segments) });
      segments.push({ kind: "call" });
      continue;
    }
    segments.push({ kind: "other" });
  }
  return found;
}

/** The scan's name for a call, marked `receiverCut` when it keeps the last two names of a longer path of names. */
function cutName(segments: readonly CalleeSegment[]): PatternCallName | null {
  const named = patternCallName(segments, CHAIN_DEPTH);
  const cut = named && segments.length >= 3 && segments.every((s) => s.kind === "id" && !s.colon) && named.name.split(".").length === 2;
  return cut ? { ...named, receiverCut: true } : named;
}

function idOf(token: Token): CalleeSegment {
  return { kind: "id", name: token.text ?? "", line: token.line, column: token.column };
}

/** The name a primary expression starts with (`x`, `pkg` of `pkg.Fn`); anything else names nothing. */
function baseSegments(base: ParseTree): CalleeSegment[] {
  const name = base instanceof OperandContext ? base.operandName()?.IDENTIFIER().symbol : undefined;
  return name ? [idOf(name)] : [{ kind: "other" }];
}
