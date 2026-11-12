import { TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ValueCell, ValueFlowFact } from "../../../types/analysis.js";
import { RustLexer } from "../../../parsers/antlr/rust/RustLexer.js";
import {
  RustParser,
  CallParamsContext,
  ClosureExpressionContext,
  ConditionOperandContext,
  ExpressionContext,
  Function_Context,
  IdentifierPatternContext,
  IteratorLoopExpressionContext,
  LetStatementContext,
  LiteralExpressionContext,
  MacroInvocationContext,
  PathExprSegmentContext,
  PathExpressionContext,
  PatternContext,
  PatternNoTopAltContext,
  StatementExpressionContext,
  StatementsContext,
  StructExpressionContext,
  type DelimTokenTreeContext,
  type PatternWithoutRangeContext,
  type StructExprStructContext,
} from "../../../parsers/antlr/rust/RustParser.js";
import type { PatternCallName } from "../shared/antlr-calls.js";

/**
 * Rust's function-value flow, stated as neutral facts for core's solver (`FunctionInfo.valueFlow`): `let f = save;`,
 * `let f: fn() = Club::save;`, `self.on_save = Some(Box::new(save));`, `handlers.push(Box::new(save))`,
 * `vec![save, other]`, `for h in &self.handlers`, `if let Some(cb) = &self.on_save`, a value handed to a call or
 * returned from a function (explicitly or as its tail), and the calls that run a held value — `f(x)` of a bound
 * name, `(self.on_save)(x)`, `(self.handlers[i])(x)`. A closure is no function of the project: its calls stay its
 * owner's, and a name bound to one holds nothing.
 *
 * The receiver is `self`; a list or map element is the member `[]` (a literal key also its own), a collection field's
 * elements `<field>[]`. A struct literal of the impl's own type (`Self { cb: Box::new(save) }`) stores into the
 * receiver's fields, so a constructor's callbacks reach the methods that run them.
 */

/** What the reading needs of the syntax the call walk already knows. */
export interface RustFlowHooks {
  /** The names of a plain path expression with the line of each, or null when it is something else. */
  pathNames(node: ParseTree): Array<{ name: string; line: number; column: number }> | null;
  /** The name the call walk records a `callee(args)` / `recv.method(args)` expression under, or null. */
  callName(node: ParserRuleContext): PatternCallName | null;
  /** A path expression's name as a call of it would be recorded (`Club.save`, `tools::wrench`, `save`). */
  valueName(node: ParseTree): string | null;
  /** A `vec![…]` / `[…]` macro's arguments parsed as expressions, when they read as such. */
  macroArguments(group: DelimTokenTreeContext): ParserRuleContext | null;
}

type Src = { kind: "cell"; cell: ValueCell } | { kind: "seed"; fn: string } | { kind: "result"; call: string; line: number };
interface Store { member: string; srcs: Src[] }
interface Val { srcs: Src[]; stores: Store[]; owner?: "self" }
const EMPTY: Val = { srcs: [], stores: [] };

/** Methods whose result is the receiver's value as far as a held function goes. */
const TRANSPARENT = new Set([
  "clone", "unwrap", "expect", "unwrap_or_default", "as_ref", "as_mut", "as_deref", "as_deref_mut", "borrow", "borrow_mut",
  "lock", "read", "write", "to_owned", "into", "take", "cloned", "copied", "ok",
]);
/** Methods that yield an element of a collection. */
const ELEMENT_GETTERS = new Set(["get", "get_mut", "first", "last", "pop", "remove", "pop_front", "pop_back", "swap_remove"]);
/** Methods that store their one argument as the value of the cell they are called on (`OnceLock::set`, `Cell::set`). */
const VALUE_SETTERS = new Set(["set", "replace"]);
/** A static or constant's name: held by the module, not by a local. */
const STATIC_NAME = /^[A-Z][A-Z0-9_]+$/;
/** Methods that put their last argument into the collection they are called on. */
const ELEMENT_PUTTERS = new Set(["push", "push_back", "push_front", "insert"]);
/** Iterator adapters that keep the element. */
const ITERATORS = new Set(["iter", "iter_mut", "into_iter", "values", "values_mut", "drain", "cloned", "copied"]);
/** Paths that wrap a value and hand it on. */
const WRAPPERS = new Set(["Some", "Ok", "Box.new", "Arc.new", "Rc.new", "Arc.clone", "Rc.clone", "RefCell.new", "Mutex.new", "RwLock.new", "Cell.new"]);

/** The facts of one function. `implType` is the type of the impl around it; `associated` is a function taking no `self`. */
export function rustValueFlow(fn: Function_Context, hooks: RustFlowHooks, implType: string | null, associated: boolean): { facts: ValueFlowFact[]; moduleFacts: ValueFlowFact[] } {
  const body = fn.blockExpression();
  if (!body) return { facts: [], moduleFacts: [] };
  const facts: ValueFlowFact[] = [];
  /** What the function stores into a static: module facts, since no local of the function holds it. */
  const moduleFacts: ValueFlowFact[] = [];
  let temps = 0;

  // ── Names the function binds ───────────────────────────────────────────────
  // Each name with the places from which it is bound: a pattern's declaring statement has ended (`let pool = pool();`
  // still calls the function), a parameter or closure parameter binds from its own start.
  const bound = new Map<string, Array<readonly [number, number]>>();
  const bindingStart = (pattern: ParserRuleContext): readonly [number, number] => {
    for (let up: ParserRuleContext | null = pattern.parent; up; up = up.parent) {
      if (up instanceof LetStatementContext || up instanceof ConditionOperandContext) return [up.stop?.line ?? 0, up.stop?.column ?? 0];
      if (up instanceof IteratorLoopExpressionContext) return [up.blockExpression().start?.line ?? 0, up.blockExpression().start?.column ?? 0];
      if (up instanceof ClosureExpressionContext || up instanceof Function_Context) return [up.start?.line ?? 0, up.start?.column ?? 0];
    }
    return [0, 0];
  };
  const isBound = (name: string, at: { line: number; column: number }): boolean =>
    bound.get(name)?.some(([line, column]) => line < at.line || (line === at.line && column <= at.column)) ?? false;
  const collect = (root: ParseTree): void => {
    const stack: ParseTree[] = [root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node instanceof TerminalNode) continue;
      if (node !== root && node instanceof Function_Context) continue;
      if (node instanceof IdentifierPatternContext) {
        const name = node.identifier().getText();
        if (/^[a-z_]/.test(name) && name !== "self") {
          const from = bindingStart(node);
          const list = bound.get(name);
          if (list) list.push(from);
          else bound.set(name, [from]);
        }
      }
      const kids = (node as ParserRuleContext).children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  };
  collect(fn);

  // ── Expression shapes ──────────────────────────────────────────────────────
  const isTerminal = (n: ParseTree | undefined, type: number): boolean => n instanceof TerminalNode && n.symbol.type === type;
  const isExpr = (n: ParseTree | undefined): n is ParserRuleContext => n instanceof ExpressionContext || n instanceof StatementExpressionContext;
  const stripAttributes = (n: ParseTree): ParseTree => {
    let cur = n;
    while (isExpr(cur) && (cur.children[0] as ParseTree | undefined)?.constructor.name === "OuterAttributeContext" && isExpr(cur.children.at(-1))) cur = cur.children.at(-1)!;
    return cur;
  };
  const isIdentifier = (n: ParseTree | undefined): n is ParserRuleContext => !!n && !(n instanceof TerminalNode) && (n as ParserRuleContext).ruleIndex === RustParser.RULE_identifier;

  type View =
    | { k: "path"; node: ParseTree }
    | { k: "closure" }
    | { k: "struct"; ctx: StructExprStructContext }
    | { k: "macro"; ctx: MacroInvocationContext }
    | { k: "method"; node: ParserRuleContext; recv: ParseTree; name: string; args: ParserRuleContext[] }
    | { k: "field"; base: ParseTree; name: string }
    | { k: "call"; node: ParserRuleContext; callee: ParseTree; args: ParserRuleContext[] }
    | { k: "index"; base: ParseTree; index: ParseTree }
    | { k: "through"; inner: ParseTree }
    | { k: "assign"; lhs: ParseTree; rhs: ParseTree }
    | { k: "return"; value: ParseTree | null }
    | { k: "array"; elems: ParserRuleContext[] }
    | { k: "tuple"; elems: ParserRuleContext[] }
    | { k: "other" };
  const argsOf = (c: readonly ParseTree[]): ParserRuleContext[] => {
    const params = c.find((x): x is CallParamsContext => x instanceof CallParamsContext);
    return params ? params.expression() : [];
  };
  const view = (n0: ParseTree): View => {
    const n = stripAttributes(n0);
    if (!isExpr(n)) return { k: "other" };
    const c = n.children;
    if (c.length === 1) {
      const x = c[0]!;
      if (x instanceof PathExpressionContext) return { k: "path", node: n };
      if (x instanceof ClosureExpressionContext) return { k: "closure" };
      if (x instanceof StructExpressionContext) return { k: "struct", ctx: x.structExprStruct() };
      if (x instanceof MacroInvocationContext) return { k: "macro", ctx: x };
      return { k: "other" };
    }
    if (isExpr(c[0]) && isTerminal(c[1], RustLexer.DOT) && c[2] instanceof PathExprSegmentContext && isTerminal(c[3], RustLexer.LPAREN)) {
      return { k: "method", node: n, recv: c[0]!, name: c[2].pathIdentSegment().getText(), args: argsOf(c) };
    }
    if (c.length === 3 && isExpr(c[0]) && isTerminal(c[1], RustLexer.DOT) && isIdentifier(c[2])) return { k: "field", base: c[0]!, name: c[2].getText() };
    if (isExpr(c[0]) && isTerminal(c[1], RustLexer.LPAREN)) return { k: "call", node: n, callee: c[0]!, args: argsOf(c) };
    if (c.length === 4 && isExpr(c[0]) && isTerminal(c[1], RustLexer.LSQUAREBRACKET)) return { k: "index", base: c[0]!, index: c[2]! };
    if (c.length === 2 && isExpr(c[0]) && isTerminal(c[1], RustLexer.QUESTION)) return { k: "through", inner: c[0]! };
    if (c.length === 3 && isExpr(c[0]) && (isTerminal(c[1], RustLexer.KW_AS) || (isTerminal(c[1], RustLexer.DOT) && isTerminal(c[2], RustLexer.KW_AWAIT)))) return { k: "through", inner: c[0]! };
    if ((isTerminal(c[0], RustLexer.AND) || isTerminal(c[0], RustLexer.ANDAND) || isTerminal(c[0], RustLexer.STAR)) && isExpr(c.at(-1))) return { k: "through", inner: c.at(-1)! };
    if (c.length === 3 && isExpr(c[0]) && isTerminal(c[1], RustLexer.EQ) && isExpr(c[2])) return { k: "assign", lhs: c[0]!, rhs: c[2]! };
    if (isTerminal(c[0], RustLexer.KW_RETURN)) return { k: "return", value: isExpr(c[1]) ? c[1]! : null };
    if (isTerminal(c[0], RustLexer.LPAREN)) {
      const inner = c.filter(isExpr);
      if (inner.length === 1 && isTerminal(c.at(-1), RustLexer.RPAREN)) return { k: "through", inner: inner[0]! };
      const elements = c.find((x): x is ParserRuleContext => !(x instanceof TerminalNode) && (x as ParserRuleContext).ruleIndex === RustParser.RULE_tupleElements);
      return elements ? { k: "tuple", elems: (elements.children.filter(isExpr) as ParserRuleContext[]) } : { k: "other" };
    }
    if (isTerminal(c[0], RustLexer.LSQUAREBRACKET)) {
      const elements = c.find((x): x is ParserRuleContext => !(x instanceof TerminalNode) && (x as ParserRuleContext).ruleIndex === RustParser.RULE_arrayElements);
      if (!elements || elements.children.some((x) => isTerminal(x, RustLexer.SEMI))) return { k: "other" };
      return { k: "array", elems: elements.children.filter(isExpr) as ParserRuleContext[] };
    }
    return { k: "other" };
  };

  const lineOf = (n: ParseTree): number => (n as ParserRuleContext).start?.line ?? 0;
  const columnOf = (n: ParseTree): number => (n as ParserRuleContext).start?.column ?? 0;
  const literalKey = (n: ParseTree): string | null => {
    const v = stripAttributes(n);
    if (!isExpr(v) || v.children.length !== 1 || !(v.children[0] instanceof LiteralExpressionContext)) return null;
    const t = v.getText();
    return /^"[^"\\]*"$/.test(t) ? t.slice(1, -1) : null;
  };
  const elementMembers = (prefix: string | undefined, key: string | null): string[] => {
    const all = prefix === undefined ? "[]" : `${prefix}[]`;
    if (key === null) return [all];
    return [prefix === undefined ? key : `${prefix}[${key}]`, all];
  };

  /** The one name a plain single-segment path is. */
  const singleName = (node: ParseTree): { name: string; line: number; column: number } | null => {
    const names = hooks.pathNames(node);
    return names?.length === 1 ? names[0]! : null;
  };
  /** The base of a place: `self`, or a name the function binds. */
  const baseOf = (node: ParseTree): string | null => {
    const v = view(node);
    if (v.k === "through") return baseOf(v.inner);
    if (v.k === "method" && TRANSPARENT.has(v.name)) return baseOf(v.recv);
    if (v.k !== "path") return null;
    const one = singleName(node);
    return one && (one.name === "self" || isBound(one.name, one)) ? one.name : null;
  };

  /** The cells an expression names as a place or reads as a value of one. */
  const cellsOf = (node: ParseTree): ValueCell[] => {
    const v = view(node);
    switch (v.k) {
      case "path": {
        const one = singleName(node);
        if (!one || one.name === "self") return [];
        return isBound(one.name, one) || STATIC_NAME.test(one.name) ? [{ name: one.name }] : [];
      }
      case "through": return cellsOf(v.inner);
      case "method": return TRANSPARENT.has(v.name) ? cellsOf(v.recv) : [];
      case "field": {
        const base = baseOf(v.base);
        return base ? [{ name: base, member: v.name }] : [];
      }
      case "index": {
        const key = literalKey(v.index);
        const inner = view(v.base);
        if (inner.k === "field") {
          const base = baseOf(inner.base);
          return base ? elementMembers(inner.name, key).map((member) => ({ name: base, member })) : [];
        }
        const base = baseOf(v.base);
        return base && base !== "self" ? elementMembers(undefined, key).map((member) => ({ name: base, member })) : [];
      }
      default: return [];
    }
  };
  const elementOf = (cells: ValueCell[]): Src[] => cells.map((c) => ({ kind: "cell" as const, cell: { name: c.name, member: c.member === undefined ? "[]" : `${c.member}[]` } }));

  const wrapperKey = (node: ParseTree): string | null => {
    const names = hooks.pathNames(node);
    if (!names) return null;
    return names.slice(-2).map((n) => n.name).join(".");
  };

  const valueOf = (node: ParseTree): Val => {
    const v = view(node);
    switch (v.k) {
      case "path": {
        const names = hooks.pathNames(node);
        if (!names) return EMPTY;
        const leaf = names.at(-1)!.name;
        if (names.length === 1) {
          if (leaf === "self" || /^[A-Z]/.test(leaf)) return EMPTY;
          if (isBound(leaf, names[0]!)) return { srcs: [{ kind: "cell", cell: { name: leaf } }], stores: [] };
        } else if (/^[A-Z]/.test(leaf)) return EMPTY;
        const name = hooks.valueName(node);
        return name ? { srcs: [{ kind: "seed", fn: implType && name.startsWith("Self.") ? `${implType}.${name.slice(5)}` : name }], stores: [] } : EMPTY;
      }
      case "through": return valueOf(v.inner);
      case "field":
      case "index": return { srcs: cellsOf(node).map((cell) => ({ kind: "cell" as const, cell })), stores: [] };
      case "method": {
        if (TRANSPARENT.has(v.name)) return valueOf(v.recv);
        // `CALLBACK.get()` of a `OnceLock`/`Cell`: the value itself; `handlers.get(k)`: an element.
        if (v.name === "get" && v.args.length === 0) return { srcs: cellsOf(v.recv).map((cell) => ({ kind: "cell" as const, cell })), stores: [] };
        if (ELEMENT_GETTERS.has(v.name)) return { srcs: elementOf(cellsOf(v.recv)), stores: [] };
        const named = hooks.callName(v.node);
        return named ? { srcs: [{ kind: "result", call: named.name, line: named.line }], stores: [] } : EMPTY;
      }
      case "call": {
        const key = wrapperKey(v.callee);
        if (key && WRAPPERS.has(key) && v.args.length >= 1) return valueOf(v.args[key.endsWith("clone") ? 0 : v.args.length - 1]!);
        const named = hooks.callName(v.node);
        return named ? { srcs: [{ kind: "result", call: named.name, line: named.line }], stores: [] } : EMPTY;
      }
      case "macro": {
        if (v.ctx.simplePath().getText().split("::").pop() !== "vec") return EMPTY;
        const params = hooks.macroArguments(v.ctx.delimTokenTree());
        const elems = params instanceof CallParamsContext ? params.expression() : [];
        return collectionOf(elems);
      }
      case "array": return collectionOf(v.elems);
      case "struct": return structOf(v.ctx);
      default: return EMPTY;
    }
  };
  const collectionOf = (elems: ParserRuleContext[]): Val => {
    const srcs = elems.flatMap((e) => valueOf(e).srcs);
    return { srcs: [], stores: srcs.length > 0 ? [{ member: "[]", srcs }] : [] };
  };
  /** A bare name as a value: a bound local, else a function in scope. */
  const nameValue = (name: string, at: { line: number; column: number }): Val => {
    if (name === "self" || /^[A-Z]/.test(name)) return EMPTY;
    return { srcs: [isBound(name, at) ? { kind: "cell", cell: { name } } : { kind: "seed", fn: name }], stores: [] };
  };
  const structOf = (ctx: StructExprStructContext): Val => {
    const last = ctx.pathInExpression().pathExprSegment().at(-1)?.getText().replace(/<.*$/, "") ?? "";
    const stores: Store[] = [];
    for (const field of ctx.structExprFields()?.structExprField() ?? []) {
      const id = field.identifier();
      if (!id) continue;
      const expression = field.expression();
      const value = expression ? valueOf(expression) : nameValue(id.getText(), { line: lineOf(id), column: columnOf(id) });
      if (value.srcs.length > 0) stores.push({ member: `.${id.getText()}`, srcs: value.srcs });
      // A collection field written in place (`handlers: vec![f]`): its elements are the field's.
      for (const st of value.stores) stores.push({ member: `.${id.getText()}${st.member}`, srcs: st.srcs });
    }
    // The impl's own type is the receiver's fields, whatever the method is called.
    // Only an associated function (no `self`) builds the instance whose fields are the receiver's; a method taking `self` makes another one.
    return { srcs: [], stores, ...(associated && (last === "Self" || (implType !== null && last === implType)) ? { owner: "self" as const } : {}) };
  };

  // ── Facts ──────────────────────────────────────────────────────────────────
  const bindSrc = (to: ValueCell, src: Src, line: number): void => {
    if (to.member === undefined && STATIC_NAME.test(to.name) && !bound.has(to.name)) {
      // A static: stated at module scope, where only a function named or another static can be a value.
      if (src.kind === "seed") moduleFacts.push({ kind: "seed", to, fn: src.fn, line });
      else if (src.kind === "cell" && STATIC_NAME.test(src.cell.name) && !bound.has(src.cell.name)) moduleFacts.push({ kind: "copy", from: src.cell, to, line });
      return;
    }
    if (src.kind === "cell") facts.push({ kind: "copy", from: src.cell, to, line });
    else if (src.kind === "seed") facts.push({ kind: "seed", to, fn: src.fn, line });
    else facts.push({ kind: "result", call: src.call, line: src.line, to });
  };
  const storeCell = (to: ValueCell, member: string): ValueCell => {
    if (to.member === undefined) return { name: to.name, member: member.startsWith(".") ? member.slice(1) : member };
    return { name: to.name, member: `${to.member}${member}` };
  };
  const bindVal = (to: ValueCell, v: Val, line: number): void => {
    if (v.owner === "self") {
      for (const st of v.stores) for (const s of st.srcs) bindSrc(storeCell({ name: "self" }, st.member), s, line);
      return;
    }
    for (const s of v.srcs) bindSrc(to, s, line);
    for (const st of v.stores) for (const s of st.srcs) bindSrc(storeCell(to, st.member), s, line);
    // A name that holds members only is still bound here.
    if (v.stores.length > 0 && to.member === undefined) facts.push({ kind: "copy", from: to, to, line });
  };
  const cellFor = (srcs: Src[], line: number, column: number): ValueCell | null => {
    if (srcs.length === 0) return null;
    if (srcs.length === 1 && srcs[0]!.kind === "cell") return srcs[0]!.cell;
    const tmp: ValueCell = { name: `$v${line}_${column}_${temps++}` };
    for (const s of srcs) bindSrc(tmp, s, line);
    return tmp;
  };

  /** What a pattern binds from a value: a name, a tuple's names pairwise, `Some(x)` the wrapped value. */
  const bindPattern = (pattern: ParseTree | null, node: ParseTree | null, v: Val, line: number): void => {
    if (!pattern) return;
    if (pattern instanceof PatternContext) {
      if (pattern.patternNoTopAlt().length === 1) bindPattern(pattern.patternNoTopAlt(0)!, node, v, line);
      return;
    }
    if (pattern instanceof PatternNoTopAltContext) return bindPattern(pattern.patternWithoutRange(), node, v, line);
    const without = pattern as PatternWithoutRangeContext;
    const ident = without.identifierPattern?.();
    if (ident) {
      const name = ident.identifier().getText();
      if (!ident.AT() && /^[a-z_]/.test(name) && name !== "_") bindVal({ name }, v, line);
      return;
    }
    const reference = without.referencePattern?.();
    if (reference) return bindPattern(reference.patternWithoutRange(), node, v, line);
    const grouped = without.groupedPattern?.();
    if (grouped) return bindPattern(grouped.pattern(), node, v, line);
    const wrapped = without.tupleStructPattern?.();
    if (wrapped) {
      const items = wrapped.tupleStructItems()?.pattern() ?? [];
      const leaf = wrapped.pathInExpression().pathExprSegment().at(-1)?.getText();
      if (items.length === 1 && (leaf === "Some" || leaf === "Ok")) bindPattern(items[0]!, node, v, line);
      return;
    }
    const tuple = without.tuplePattern?.();
    if (tuple && node) {
      const items = tuple.tuplePatternItems()?.pattern() ?? [];
      const rhs = view(node);
      if (rhs.k === "tuple" && rhs.elems.length === items.length) items.forEach((p, i) => bindPattern(p, rhs.elems[i]!, valueOf(rhs.elems[i]!), line));
    }
  };

  const iterable = (node: ParseTree): Val => {
    const v = view(node);
    if (v.k === "through") return iterable(v.inner);
    if (v.k === "method" && ITERATORS.has(v.name)) return iterable(v.recv);
    return valueOf(node);
  };

  /** Where an assignment's left side stores. */
  const assignTo = (lhs: ParseTree, v: Val, line: number): void => {
    for (const cell of cellsOf(lhs)) bindVal(cell, v, line);
  };

  const callFacts = (node: ParserRuleContext, inClosure: boolean): void => {
    const v = view(node);
    if (v.k !== "call" && v.k !== "method") return;
    const line = lineOf(node);
    const named = hooks.callName(node);
    if (v.k === "method" && ELEMENT_PUTTERS.has(v.name) && v.args.length >= 1) {
      // `hooks.push(f)`, `map.insert("k", f)`: the last argument becomes an element.
      const value = valueOf(v.args.at(-1)!).srcs;
      const key = v.name === "insert" && v.args.length === 2 ? literalKey(v.args[0]!) : null;
      if (value.length > 0) for (const cell of cellsOf(v.recv)) {
        const base = cell.member === undefined ? undefined : cell.member;
        if (cell.member === undefined || !cell.member.endsWith("]")) {
          for (const member of elementMembers(base, key)) for (const s of value) bindSrc({ name: cell.name, member }, s, line);
        }
      }
    }
    if (v.k === "method" && VALUE_SETTERS.has(v.name) && v.args.length === 1) {
      const value = valueOf(v.args[0]!).srcs;
      if (value.length > 0) for (const cell of cellsOf(v.recv)) for (const s of value) bindSrc(cell, s, line);
    }
    if (named && !(v.k === "call" && WRAPPERS.has(wrapperKey(v.callee) ?? ""))) {
      v.args.forEach((arg, index) => {
        const cell = cellFor(valueOf(arg).srcs, lineOf(arg), columnOf(arg));
        if (cell) facts.push({ kind: "arg", call: named.name, line: named.line, index, from: cell });
      });
    }
    if (v.k !== "call") return;
    // What the callee holds runs: a name the function binds, or a field, element or wrapped value.
    const callee = view(v.callee);
    if (callee.k === "path") {
      const one = singleName(v.callee);
      if (one && one.name !== "self" && isBound(one.name, one)) facts.push({ kind: "invoke", cell: { name: one.name }, call: one.name, line: one.line });
      return;
    }
    if (callee.k === "closure" || callee.k === "other") return;
    const cell = cellFor(valueOf(v.callee).srcs.filter((s) => s.kind === "cell"), lineOf(v.callee), columnOf(v.callee));
    if (cell) facts.push({ kind: "invoke", cell, call: cell.member === undefined ? cell.name : `${cell.name}.${cell.member}`, line: lineOf(v.callee) });
    void inClosure;
  };

  /** The value a function body ends in: the last statement of its block, when it has no `;`. */
  const tailOf = (statements: StatementsContext | null): ParseTree | null => {
    const tail = statements?.statementsTail();
    if (!tail) return null;
    const expr = tail.statementExpression();
    if (!expr) return null;
    if (tail.SEMI()) return tailOf(tail.statements());
    return expr;
  };

  /** A returned value: its function values, and the fields a literal of the impl's own type states. */
  const returned = (node: ParseTree, line: number): void => {
    const v = valueOf(node);
    if (v.owner === "self") bindVal({ name: "self" }, v, line);
    const cell = cellFor(v.srcs, line, columnOf(node));
    if (cell) facts.push({ kind: "return", from: cell, line });
  };

  const visit = (root: ParseTree): void => {
    const stack: Array<{ node: ParseTree; closure: boolean }> = [{ node: root, closure: false }];
    while (stack.length > 0) {
      const { node, closure } = stack.pop()!;
      if (node instanceof TerminalNode) continue;
      if (node !== fn && node instanceof Function_Context) continue;
      const ctx = node as ParserRuleContext;
      const line = lineOf(ctx);
      if (ctx instanceof LetStatementContext) {
        const init = ctx.expression();
        if (init) bindPattern(ctx.patternNoTopAlt(), init, valueOf(init), line);
      } else if (ctx instanceof IteratorLoopExpressionContext) {
        const over = iterable(ctx.expression());
        const elements: Val = { srcs: elementOf(over.srcs.flatMap((s) => (s.kind === "cell" ? [s.cell] : []))), stores: [] };
        if (over.stores.length > 0) {
          const tmp: ValueCell = { name: `$v${line}_${temps++}` };
          bindVal(tmp, over, line);
          elements.srcs.push({ kind: "cell", cell: { name: tmp.name, member: "[]" } });
        }
        if (elements.srcs.length > 0) bindPattern(ctx.pattern(), null, elements, line);
      } else if (ctx instanceof ConditionOperandContext && ctx.KW_LET() && ctx.pattern()) {
        bindPattern(ctx.pattern(), ctx.expression(), valueOf(ctx.expression()), line);
      } else if (isExpr(ctx)) {
        const v = view(ctx);
        if (v.k === "assign") assignTo(v.lhs, valueOf(v.rhs), line);
        else if (v.k === "return" && v.value && !closure) returned(v.value, line); else if (v.k === "call" || v.k === "method") callFacts(ctx, closure);
      }
      const nextClosure = closure || ctx instanceof ClosureExpressionContext;
      for (let i = ctx.children.length - 1; i >= 0; i--) stack.push({ node: ctx.children[i]!, closure: nextClosure });
    }
  };

  visit(body);
  const tail = tailOf(body.statements());
  if (tail) returned(tail, lineOf(tail));
  return { facts, moduleFacts };
}
