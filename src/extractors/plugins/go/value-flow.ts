import { TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { GoLexer } from "../../../parsers/antlr/go/GoLexer.js";
import {
  ArgumentsContext,
  AssignmentContext,
  CompositeLitContext,
  ConversionContext,
  ExpressionContext,
  FunctionLitContext,
  IndexContext,
  MethodDeclContext,
  OperandContext,
  PrimaryExprContext,
  RangeClauseContext,
  ReturnStmtContext,
  ShortVarDeclContext,
  StructTypeContext,
  TypeDefContext,
  VarSpecContext,
  type ExpressionListContext,
  type Type_Context,
} from "../../../parsers/antlr/go/GoParser.js";
import type { PatternCallName } from "../shared/antlr-calls.js";

/**
 * Go's function-value flow, stated as neutral facts for core's solver (`FunctionInfo.valueFlow`,
 * `FileAnalysis.moduleValueFlow`): `h := save`, `a, b := f, g`, `c.onSave = save`, `m := map[string]func(){"k": save}`,
 * `for _, f := range hooks`, `return save`, a value handed to a call or returned by one, and the calls that run a
 * held value — a bare call of a parameter or local (`f()`), of a field the file declares function-typed
 * (`c.onSave()`), of an element (`m[k]()`).
 *
 * A method's receiver is `this`; a list or map element is the member `[]` (a literal key also its own); a field
 * that is itself a collection spells its elements `<field>[]`. The reading is syntactic and flow-insensitive: what
 * a name stands for, and which function a seed names, is core's to resolve.
 */

/** What the reading needs of the file beyond the tree it walks. */
export interface GoFlowEnv {
  /** Each argument list of a primary expression, by child index, with the call's recorded name. */
  applications(ctx: PrimaryExprContext): Array<{ at: number; named: PatternCallName | null }>;
  /** Names the file declares at package level as variables (not function-literal ones, which are functions). */
  packageVars: ReadonlySet<string>;
  /** Struct fields the file declares with a function type, or a collection of them. */
  funcFields: ReadonlySet<string>;
  /** Types the file declares as function types (`type Handler func(…)`). */
  funcTypes: ReadonlySet<string>;
}

/** A place in the source: 1-based line, 0-based column. */
interface Pos { line: number; column: number }
/** Each name the roots declare with the places from which it is bound there (the end of its declaring statement). */
export type GoBound = ReadonlyMap<string, ReadonlyArray<readonly [number, number]>>;

type Src = { kind: "cell"; cell: ValueCell } | { kind: "seed"; fn: string } | { kind: "result"; call: string; line: number };
interface Store { member: string; srcs: Src[] }
interface Val { srcs: Src[]; stores: Store[] }
const EMPTY: Val = { srcs: [], stores: [] };

/** Identifiers that are values of no function. */
const NOT_FUNCTIONS = new Set(["true", "false", "nil", "iota", "_", "err", "ctx"]);

/**
 * The facts of `roots` (a function declaration, or the function literals of a package variable, or a package-level
 * spec). `receiver` is the method receiver's name; `bound` every name the roots declare. With `moduleLevel` the
 * roots are package-level statements and every fact is a module fact.
 */
export function goValueFlow(
  roots: readonly ParserRuleContext[],
  opts: { receiver?: string; bound: GoBound; env: GoFlowEnv; moduleLevel?: boolean },
): { facts: ValueFlowFact[]; moduleFacts: ValueFlowFact[] } {
  const { receiver, bound, env, moduleLevel } = opts;
  const facts: ValueFlowFact[] = [];
  const moduleFacts: ValueFlowFact[] = [];
  const out = moduleLevel ? moduleFacts : facts;
  let temps = 0;

  /** Whether a name is bound at a use: its binding statement has ended (`pool := pool()` calls the function). */
  const isBound = (name: string, at: Pos): boolean => bound.get(name)?.some(([line, column]) => line < at.line || (line === at.line && column <= at.column)) ?? false;
  const known = (name: string, at: Pos): boolean => isBound(name, at) || env.packageVars.has(name);
  const head = (name: string, at: Pos): string | null => (name === receiver ? "this" : known(name, at) ? name : null);

  const unwrap = (e: ExpressionContext | null): PrimaryExprContext | null => {
    let cur: ExpressionContext | null = e;
    while (cur && cur.children.length === 2 && cur.children[0] instanceof TerminalNode
      && (cur.children[0].symbol.type === GoLexer.STAR || cur.children[0].symbol.type === GoLexer.AMPERSAND)) {
      cur = cur.children[1] as ExpressionContext;
    }
    return cur && cur.children.length === 1 && cur.children[0] instanceof PrimaryExprContext ? cur.children[0] : null;
  };

  type Step = { k: "dot"; name: string } | { k: "index"; expr: ExpressionContext } | { k: "call"; at: number } | { k: "other" };
  const stepsOf = (p: PrimaryExprContext): Step[] => {
    const steps: Step[] = [];
    for (let i = 1; i < p.children.length; i++) {
      const c = p.children[i]!;
      if (c instanceof TerminalNode) {
        if (c.symbol.type === GoLexer.IDENTIFIER) steps.push({ k: "dot", name: c.getText() });
        continue;
      }
      if (c instanceof IndexContext) steps.push({ k: "index", expr: c.expression() });
      else if (c instanceof ArgumentsContext) steps.push({ k: "call", at: i });
      else steps.push({ k: "other" });
    }
    return steps;
  };
  const headIdent = (p: PrimaryExprContext): { name: string; line: number; column: number } | null => {
    const operand = p.children[0];
    if (!(operand instanceof OperandContext) || operand.children.length !== 1) return null;
    const id = operand.operandName()?.IDENTIFIER().symbol;
    return id ? { name: id.text ?? "", line: id.line, column: id.column } : null;
  };
  const literalKey = (e: ExpressionContext): string | null => {
    const t = e.getText();
    return /^"[^"\\]*"$/.test(t) ? t.slice(1, -1) : null;
  };

  /** The member(s) a read or write of `base[index]` names: the literal key, else the element member. */
  const elementMembers = (prefix: string | undefined, key: string | null): string[] => {
    const all = prefix === undefined ? "[]" : `${prefix}[]`;
    if (key === null) return [all];
    return [prefix === undefined ? key : `${prefix}[${key}]`, all];
  };

  /** The cells a primary expression names as a place: `x`, `c.f`, `m[k]`, `c.hooks[k]`. */
  const cellsOf = (p: PrimaryExprContext): ValueCell[] => {
    const id = headIdent(p);
    if (!id) return [];
    const steps = stepsOf(p);
    const base = head(id.name, id);
    if (steps.length === 0) return base && base !== "this" ? [{ name: base }] : [];
    if (!base) return [];
    if (steps.length === 1 && steps[0]!.k === "dot") return [{ name: base, member: steps[0]!.name }];
    if (steps.length === 1 && steps[0]!.k === "index") return base === "this" ? [] : elementMembers(undefined, literalKey(steps[0]!.expr)).map((member) => ({ name: base, member }));
    if (steps.length === 2 && steps[0]!.k === "dot" && steps[1]!.k === "index") {
      return elementMembers(steps[0]!.name, literalKey(steps[1]!.expr)).map((member) => ({ name: base, member }));
    }
    return [];
  };

  const valueOf = (e: ExpressionContext | null): Val => {
    const p = unwrap(e);
    return p ? valueOfPrimary(p) : EMPTY;
  };

  const compositeVal = (c: CompositeLitContext): Val => {
    const type = c.literalType();
    const struct = type.structType() !== null;
    const named = type.typeName() !== null;
    const stores: Store[] = [];
    for (const ke of c.literalValue().elementList()?.keyedElement() ?? []) {
      const element = ke.element().expression();
      if (!element) continue;
      const srcs = valueOf(element).srcs;
      if (srcs.length === 0) continue;
      const keyExpr = ke.key()?.expression() ?? null;
      const key = keyExpr ? literalKey(keyExpr) : null;
      const ident = keyExpr && !key && /^[A-Za-z_]\w*$/.test(keyExpr.getText()) ? keyExpr.getText() : null;
      if (struct) {
        if (ident) stores.push({ member: `.${ident}`, srcs });
      } else {
        // A named type may be a struct or a named slice/map: a bare key is a field there, an element anywhere.
        if (named && ident) stores.push({ member: `.${ident}`, srcs });
        for (const m of elementMembers(undefined, key)) stores.push({ member: m, srcs });
      }
    }
    return { srcs: [], stores };
  };

  const valueOfPrimary = (p: PrimaryExprContext): Val => {
    const first = p.children[0];
    if (first instanceof ConversionContext) return valueOf(first.expression());
    if (!(first instanceof OperandContext)) return EMPTY;
    const steps = stepsOf(p);
    const lit = first.literal();
    if (lit) return lit.compositeLit() && steps.length === 0 ? compositeVal(lit.compositeLit() as CompositeLitContext) : EMPTY;
    if (first.expression() && first.L_PAREN()) return steps.length === 0 ? valueOf(first.expression()) : EMPTY;
    const id = headIdent(p);
    if (!id) return EMPTY;
    const last = steps.at(-1);
    if (last?.k === "call" && steps.length === 1 && id.name === "append" && !known("append", id)) {
      // `append(hooks, f, g)`: the slice itself, with the values appended as its elements.
      const args = (p.children[last.at] as ArgumentsContext).expressionList()?.expression() ?? [];
      const rest = args.slice(1).flatMap((a) => valueOf(a).srcs);
      return { srcs: args[0] ? valueOf(args[0]).srcs : [], stores: rest.length > 0 ? [{ member: "[]", srcs: rest }] : [] };
    }
    if (last?.k === "call") {
      const apps = env.applications(p);
      const named = apps.at(-1)?.named;
      const srcs: Src[] = [];
      if (named) srcs.push({ kind: "result", call: named.name, line: named.line });
      // `Handler(save)` converts: the value is the argument's.
      const args = (p.children[last.at] as ArgumentsContext).expressionList()?.expression() ?? [];
      const callee = steps.length === 1 ? id.name : steps.length === 2 && steps[0]!.k === "dot" ? (steps[0] as { name: string }).name : "";
      if (args.length === 1 && callee && !known(id.name, id) && (env.funcTypes.has(callee) || /HandlerFunc$/.test(callee))) srcs.push(...valueOf(args[0]!).srcs);
      return { srcs, stores: [] };
    }
    if (steps.some((s) => s.k === "call" || s.k === "other")) return EMPTY;
    const base = head(id.name, id);
    if (steps.length === 0) {
      if (base && base !== "this") return { srcs: [{ kind: "cell", cell: { name: base } }], stores: [] };
      if (base || NOT_FUNCTIONS.has(id.name)) return EMPTY;
      return { srcs: [{ kind: "seed", fn: id.name }], stores: [] };
    }
    if (steps.length === 1 && steps[0]!.k === "dot") {
      const member = steps[0]!.name;
      if (base) {
        const srcs: Src[] = [{ kind: "cell", cell: { name: base, member } }];
        // A method value: the receiver's own method of that name.
        if (!env.packageVars.has(id.name) || isBound(id.name, id)) srcs.push({ kind: "seed", fn: `${id.name}.${member}` });
        return { srcs, stores: [] };
      }
      return { srcs: [{ kind: "seed", fn: `${id.name}.${member}` }], stores: [] };
    }
    return { srcs: cellsOf(p).map((cell) => ({ kind: "cell" as const, cell })), stores: [] };
  };

  const hasStores = (v: Val): boolean => v.stores.length > 0;

  const bindSrc = (to: ValueCell, src: Src, line: number): void => {
    if (src.kind === "cell") out.push({ kind: "copy", from: src.cell, to, line });
    else if (src.kind === "seed") out.push({ kind: "seed", to, fn: src.fn, line });
    else out.push({ kind: "result", call: src.call, line: src.line, to });
  };
  const storeCell = (to: ValueCell, member: string): ValueCell => {
    // Elements and fields of a bare name are its members; of a member (`c.hooks`), the member spelled further.
    if (to.member === undefined) return { name: to.name, member: member.startsWith(".") ? member.slice(1) : member };
    return { name: to.name, member: `${to.member}${member}` };
  };
  const bindVal = (to: ValueCell, v: Val, line: number): void => {
    for (const s of v.srcs) bindSrc(to, s, line);
    for (const st of v.stores) for (const s of st.srcs) bindSrc(storeCell(to, st.member), s, line);
    // The name holds members only: say it is bound here.
    if (hasStores(v) && to.member === undefined) out.push({ kind: "copy", from: to, to, line });
  };
  /** A cell standing for the sources: the one cell they are, else a hidden local they are bound to. */
  const cellFor = (srcs: Src[], line: number, column: number): ValueCell | null => {
    if (srcs.length === 0) return null;
    if (srcs.length === 1 && srcs[0]!.kind === "cell") return srcs[0]!.cell;
    const tmp: ValueCell = { name: `$v${line}_${column}_${temps++}` };
    for (const s of srcs) bindSrc(tmp, s, line);
    return tmp;
  };

  /** Where a statement's left side stores to; a package variable assigned inside a function is a module fact. */
  const assignTo = (lhs: ExpressionContext, v: Val, line: number): void => {
    const p = unwrap(lhs);
    if (!p) return;
    const id = headIdent(p);
    if (!id || id.name === "_") return;
    const cells = cellsOf(p);
    if (cells.length === 0) return;
    const moduleVar = !moduleLevel && !isBound(id.name, id) && id.name !== receiver && env.packageVars.has(id.name);
    if (moduleVar) {
      // Module scope states only what needs no local: a function named, or another package variable.
      const modular = (s: Src): boolean => (s.kind === "cell" && !isBound(s.cell.name, id) && env.packageVars.has(s.cell.name)) || (s.kind === "seed" && !s.fn.includes("."));
      const state = (to: ValueCell, s: Src): void => {
        if (s.kind === "cell") moduleFacts.push({ kind: "copy", from: s.cell, to, line });
        else if (s.kind === "seed") moduleFacts.push({ kind: "seed", to, fn: s.fn, line });
      };
      for (const cell of cells) {
        for (const s of v.srcs) if (modular(s)) state(cell, s);
        // `hooks = append(hooks, save)`, `registry = []Handler{save}`: the elements it states.
        for (const st of v.stores) for (const s of st.srcs) if (modular(s)) state(storeCell(cell, st.member), s);
      }
      // The variable may be declared without a value: say it is the module's.
      moduleFacts.push({ kind: "copy", from: { name: id.name }, to: { name: id.name }, line });
      return;
    }
    for (const cell of cells) bindVal(cell, v, line);
  };

  const pairs = (names: ExpressionContext[] | string[], values: ExpressionContext[], each: (i: number, v: Val) => void): void => {
    if (values.length === names.length) values.forEach((e, i) => each(i, valueOf(e)));
    else if (values.length === 1) {
      // `a, err := f()`: the call's result is every name's.
      const v = valueOf(values[0]!);
      for (let i = 0; i < names.length; i++) each(i, v);
    }
  };
  const exprs = (list: ExpressionListContext | null): ExpressionContext[] => list?.expression() ?? [];

  const visit = (root: ParserRuleContext, inLiteral: boolean): void => {
    const stack: Array<{ node: ParseTree; lit: boolean }> = [{ node: root, lit: inLiteral }];
    while (stack.length > 0) {
      const { node, lit } = stack.pop()!;
      if (node instanceof TerminalNode) continue;
      const ctx = node as ParserRuleContext;
      const line = ctx.start?.line ?? 0;
      if (ctx instanceof ShortVarDeclContext) {
        const names = ctx.identifierList().IDENTIFIER().map((t) => t.getText());
        pairs(names, exprs(ctx.expressionList()), (i, v) => {
          if (names[i] !== "_") bindVal({ name: names[i]! }, v, line);
        });
      } else if (ctx instanceof VarSpecContext && ctx.expressionList()) {
        const names = ctx.identifierList().IDENTIFIER().map((t) => t.getText());
        pairs(names, exprs(ctx.expressionList()), (i, v) => {
          if (names[i] !== "_") bindVal({ name: names[i]! }, v, line);
        });
      } else if (ctx instanceof AssignmentContext) {
        if (ctx.assign_op().children.length === 1) {
          const lhs = exprs(ctx.expressionList(0));
          pairs(lhs, exprs(ctx.expressionList(1)), (i, v) => assignTo(lhs[i]!, v, line));
        }
      } else if (ctx instanceof RangeClauseContext) {
        // The value variable of `for k, v := range xs` is an element of `xs`.
        const ids = ctx.identifierList()?.IDENTIFIER().map((t) => t.getText()) ?? [];
        const assigned = ctx.expressionList() ? exprs(ctx.expressionList()) : [];
        const target = ids.length === 2 && ids[1] !== "_" ? { name: ids[1]! } : null;
        const into = target ?? (assigned.length === 2 ? assigned[1]! : null);
        if (into) {
          const over = elementSource(valueOf(ctx.expression()), ctx.expression(), line);
          if (over && into instanceof ExpressionContext) assignTo(into, { srcs: over, stores: [] }, line);
          else if (over && !(into instanceof ExpressionContext)) for (const s of over) bindSrc(into, s, line);
        }
      } else if (ctx instanceof ReturnStmtContext && !lit) {
        for (const e of exprs(ctx.expressionList())) {
          const v = valueOf(e);
          const cell = cellFor(v.srcs, line, ctx.start?.column ?? 0);
          if (cell) out.push({ kind: "return", from: cell, line });
        }
      } else if (ctx instanceof PrimaryExprContext) {
        callFacts(ctx);
      }
      // A literal nested in the roots is its own function; a root that is a literal is the function read.
      const nextLit = lit || (ctx instanceof FunctionLitContext && ctx !== root);
      for (let i = ctx.children.length - 1; i >= 0; i--) stack.push({ node: ctx.children[i]!, lit: nextLit });
    }
  };

  /** The elements a `range` expression yields: its element member, or the elements of a literal written there. */
  const elementSource = (v: Val, e: ExpressionContext, line: number): Src[] | null => {
    const p = unwrap(e);
    if (!p) return null;
    if (hasStores(v)) {
      const tmp: ValueCell = { name: `$v${line}_${temps++}` };
      bindVal(tmp, v, line);
      return [{ kind: "cell", cell: { name: tmp.name, member: "[]" } }];
    }
    const cells = cellsOf(p);
    if (cells.length !== 1) return null;
    const c = cells[0]!;
    if (c.member === undefined) return [{ kind: "cell", cell: { name: c.name, member: "[]" } }];
    return [{ kind: "cell", cell: { name: c.name, member: `${c.member}[]` } }];
  };

  /** Arguments handed to a call, and the call of a held value. */
  const callFacts = (p: PrimaryExprContext): void => {
    const steps = stepsOf(p);
    if (!steps.some((s) => s.k === "call")) return;
    const id = headIdent(p);
    const apps = env.applications(p);
    for (const { at, named } of apps) {
      const args = p.children[at] as ArgumentsContext;
      const callLine = named?.line ?? id?.line ?? p.start?.line ?? 0;
      if (named && !takesValuesOnly(p, at)) {
        (args.expressionList()?.expression() ?? []).forEach((arg, index) => {
          const v = valueOf(arg);
          const cell = cellFor(v.srcs, arg.start?.line ?? callLine, arg.start?.column ?? 0);
          if (cell) out.push({ kind: "arg", call: named.name, line: named.line, index, from: cell });
        });
      }
      // The first call of the expression runs what its callee names, when that is a held value.
      const callee = steps.slice(0, steps.findIndex((st) => st.k === "call" && st.at === at));
      if (callee.some((s) => s.k === "call" || s.k === "other") || !id) continue;
      const base = head(id.name, id);
      if (!base) continue;
      if (callee.length === 0 && base !== "this") out.push({ kind: "invoke", cell: { name: base }, call: id.name, line: id.line });
      else if (callee.length === 1 && callee[0]!.k === "dot" && env.funcFields.has((callee[0] as { name: string }).name)) {
        const member = (callee[0] as { name: string }).name;
        out.push({ kind: "invoke", cell: { name: base, member }, call: named?.name ?? `${id.name}.${member}`, line: named?.line ?? id.line });
      } else if (callee.length === 1 && callee[0]!.k === "index" && base !== "this") {
        for (const member of elementMembers(undefined, literalKey((callee[0] as { expr: ExpressionContext }).expr)).slice(0, 1)) {
          out.push({ kind: "invoke", cell: { name: base, member }, call: `${id.name}[]`, line: id.line });
        }
      } else if (callee.length === 2 && callee[0]!.k === "dot" && callee[1]!.k === "index" && env.funcFields.has((callee[0] as { name: string }).name)) {
        const field = (callee[0] as { name: string }).name;
        const key = literalKey((callee[1] as { expr: ExpressionContext }).expr);
        out.push({ kind: "invoke", cell: { name: base, member: elementMembers(field, key)[0]! }, call: `${id.name}.${field}[]`, line: id.line });
      }
    }
  };

  /** Built-ins and formatting calls only read their arguments. */
  const takesValuesOnly = (p: PrimaryExprContext, at: number): boolean => {
    const first = p.children[0];
    const name = first instanceof OperandContext ? first.operandName()?.IDENTIFIER().getText() : undefined;
    if (!name) return false;
    if (at === 1) return BUILTINS.has(name);
    return at === 3 && VALUE_PACKAGES.has(name);
  };

  for (const root of roots) visit(root, false);
  return { facts, moduleFacts };
}

const BUILTINS = new Set([
  "len", "cap", "make", "new", "delete", "copy", "clear", "close", "min", "max", "print", "println", "panic",
  "complex", "real", "imag", "string", "bool", "byte", "rune", "int", "int8", "int16", "int32", "int64",
  "uint", "uint8", "uint16", "uint32", "uint64", "uintptr", "float32", "float64", "append",
]);
const VALUE_PACKAGES = new Set(["fmt", "log", "slog", "errors", "strconv"]);


/** Whether a type is a function type, a collection of them, or a named one the file declares as such. */
function funcish(type: Type_Context | null, funcTypes: ReadonlySet<string>): boolean {
  if (!type) return false;
  const lit = type.typeLit();
  if (lit) {
    if (lit.functionType()) return true;
    const element = lit.sliceType()?.elementType() ?? lit.arrayType()?.elementType() ?? lit.mapType()?.elementType();
    if (element) return funcish(element.type_(), funcTypes);
    const pointee = lit.pointerType()?.type_();
    return pointee ? funcish(pointee, funcTypes) : false;
  }
  const name = type.typeName()?.IDENTIFIER()?.getText();
  return !!name && funcTypes.has(name);
}

/** The file-level facts the reading needs: function types, function-typed struct fields. */
export function goFlowFileFacts(tree: ParserRuleContext): { funcFields: Set<string>; funcTypes: Set<string> } {
  const funcTypes = new Set<string>();
  const methodNames = new Set<string>();
  const structs: StructTypeContext[] = [];
  const stack: ParseTree[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    if (ctx instanceof TypeDefContext) {
      if (ctx.type_().typeLit()?.functionType()) funcTypes.add(ctx.IDENTIFIER().getText());
    } else if (ctx instanceof StructTypeContext) structs.push(ctx);
    else if (ctx instanceof MethodDeclContext) methodNames.add(ctx.IDENTIFIER().getText());
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
  const funcFields = new Set<string>();
  for (const st of structs) {
    for (const f of st.fieldDecl()) {
      if (!funcish(f.type_(), funcTypes)) continue;
      for (const id of f.identifierList()?.IDENTIFIER() ?? []) funcFields.add(id.getText());
    }
  }
  // A name that is also a method somewhere in the file may be called as one: only a field nothing else is named like holds a value.
  for (const name of methodNames) funcFields.delete(name);
  return { funcFields, funcTypes };
}
