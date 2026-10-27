import { TerminalNode, Token, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { RustLexer } from "../../../parsers/antlr/rust/RustLexer.js";
import {
  RustParser,
  BlockStepContext,
  BlockTailContext,
  CallExpressionContext,
  DelimTokenTreeContext,
  ExpressionContext,
  Function_Context,
  InnerAttributeContext,
  LiteralExpressionContext,
  MacroInvocationContext,
  MacroInvocationSemiContext,
  MacroTranscriberContext,
  MethodCallExpressionContext,
  OuterAttributeContext,
  PathExprSegmentContext,
  PathExpressionContext,
  PathInExpressionContext,
  QualifiedPathInExpressionContext,
  StatementExpressionContext,
  StructExpressionContext,
  TokenTreeContext,
} from "../../../parsers/antlr/rust/RustParser.js";
import { normalizeSource, parseWithAntlr } from "../../../parsers/antlr/run.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";

/**
 * How many calls deep a chain is named: deeper than the Rust spec's `callChainPatterns` (3), since builder chains
 * run long (`Router::new().route(…).route(…).layer(…).fallback(…)`) and the linker types each step in turn.
 */
const CHAIN_DEPTH = 8;

/**
 * Rust's functions and calls as the grammars-v4 Rust grammar reads them (the `antlr:rust` feature). A function
 * is any `fn` — free, in an `impl` or `trait`, or nested — spanning its name to its body's `}` (or its `;`), and
 * owns the calls in its body except those of a function declared inside it; a closure's calls are its owner's.
 * A call is named as the Rust spec's call patterns name it: `Club::new(` is `Club.new` on the type `Club`,
 * `Self::check(` is `Self.check`, a call through a lowercase module path (`db::query(`) is its last name, a
 * method on a name path (`self.repo.find(`) is its last two names, a method on a call's result the chain from
 * its first call (`Club::new(id).register(` is `Club.new().register`, `repo.find(id).unwrap(` is
 * `repo.find().unwrap`), and one on a value
 * the path cannot spell (`x?.y(`, `S { .. }.y(`) its bare name. Macro arguments are token trees to the
 * parser; their calls are read off the tokens by the same rules. Items a macro wraps (`cfg_server! { pub fn
 * spawn(…) { … } }`, a pattern whole crates are written in) are parsed again from the macro's text, and their
 * functions kept when that text reads cleanly as items. A raw name is the name it spells (`r#try` is `try`).
 */
export function readRust(source: string): ParsedStructure {
  return read(normalizeSource(source), 0);
}

/** How deep macros wrapping items are opened: `cfg_server! { cfg_db! { … } }`. */
const MACRO_DEPTH = 3;

interface Source {
  text: string;
  depth: number;
}

function read(text: string, depth: number): ParsedStructure {
  const { tree, errors } = parseWithAntlr(
    text,
    (input) => new RustLexer(input),
    (tokens) => new RustParser(tokens),
    (parser) => parser.crate(),
  );
  const functions: ParsedFunctionSpan[] = [];
  walk(tree, [], functions, { text, depth });
  functions.sort((a, b) => a.line - b.line);
  return { functions, topLevelCalls: [], syntaxErrors: errors };
}

/**
 * The functions of items a macro invocation wraps, read from its text at its own lines and columns. When the
 * whole text is not items, each braced group in it is tried (`cfg_if! { if #[cfg(x)] { fn … } else { fn … } }`,
 * `cfg_match! { feature => { pub fn … } }`); a group that is not items either (`select! { … }`) gives none.
 */
function macroItems(trees: TokenTreeContext[], source: Source): ParsedFunctionSpan[] {
  if (source.depth >= MACRO_DEPTH || !terminals(trees).some((t) => t.type === RustLexer.KW_FN)) return [];
  const first = trees[0]?.start;
  const last = trees.at(-1)?.stop;
  if (!first || !last) return [];
  const padded = "\n".repeat(first.line - 1) + " ".repeat(first.column) + source.text.slice(first.start, last.stop + 1);
  // A declaring macro may take a bare signature (`define_function!(fn total(x: u8) -> u8)`): retried with its `;`.
  for (const text of [padded, `${padded};`]) {
    const inner = read(text, source.depth + 1);
    if (inner.syntaxErrors === 0) return inner.functions;
  }
  return trees.flatMap((tree) => {
    const group = tree.delimTokenTree();
    if (!group?.LCURLYBRACE()) return [];
    return macroItems(group.tokenTree(), { text: source.text, depth: source.depth + 1 });
  });
}

/**
 * The functions a `macro_rules!` arm writes out, read from its transcriber as the expansion would read: a
 * metavariable is a name (`$R` → `_R`, `$crate` → `crate`, same columns), a repetition `$( … ),*` its body once.
 * A function named by a metavariable (`fn $name()`) is not one the source names, as the patterns skip it too.
 */
function templateItems(transcriber: MacroTranscriberContext, source: Source): ParsedFunctionSpan[] {
  const group = transcriber.delimTokenTree();
  const open = group.start;
  const close = group.stop;
  if (source.depth >= MACRO_DEPTH || !open || !close || !terminals([group]).some((t) => t.type === RustLexer.KW_FN)) return [];
  // Named metavariables first; when that text is not items (`$body` standing as a statement), without them.
  for (const mode of ["rename", "delete"] as const) {
    const body = expandTemplate(group, source.text, mode);
    const padded = "\n".repeat(open.line - 1) + " ".repeat(open.column + 1) + body;
    const inner = read(padded, source.depth + 1);
    if (inner.syntaxErrors > 0) continue;
    const original = source.text.slice(open.start, close.stop + 1);
    return inner.functions.filter((f) => !(f.name.startsWith("_") && original.includes(`$${f.name.slice(1)}`)));
  }
  return [];
}

/**
 * A transcriber's text with its macro syntax taken out, columns kept: `$( … ),*` is its body once, a
 * repetition of metavariables alone (`$($t)*`, code the caller splices in) is dropped, and a metavariable
 * is renamed (`$R` → `_R`) or, in `delete` mode, dropped; `$crate` is `crate`.
 */
function expandTemplate(group: DelimTokenTreeContext, text: string, mode: "rename" | "delete"): string {
  const open = group.start!;
  const chars = text.slice(open.start + 1, group.stop!.stop).split("");
  const clear = (from: number, to: number) => {
    for (let c = from; c <= to; c++) chars[c - open.start - 1] = " ";
  };
  type Item = { token: Token } | { group: DelimTokenTreeContext };
  const items = (trees: TokenTreeContext[]): Item[] =>
    trees.flatMap((tree): Item[] => {
      const inner = tree.delimTokenTree();
      return inner ? [{ group: inner }] : tree.tokenTreeToken().map((t) => ({ token: t.start! }));
    });
  const isOp = (item: Item | undefined) => item !== undefined && "token" in item && [RustLexer.STAR, RustLexer.PLUS, RustLexer.QUESTION].includes(item.token.type);
  const onlyMetavariables = (rep: DelimTokenTreeContext) => {
    const tokens = terminals(rep.tokenTree());
    return tokens.every((t, k) => t.type === RustLexer.DOLLAR || (tokens[k - 1]?.type === RustLexer.DOLLAR) || t.type === RustLexer.COMMA || t.type === RustLexer.SEMI);
  };
  const walkLevel = (trees: TokenTreeContext[]): void => {
    const level = items(trees);
    for (let k = 0; k < level.length; k++) {
      const item = level[k]!;
      if ("group" in item) {
        walkLevel(item.group.tokenTree());
        continue;
      }
      if (item.token.type !== RustLexer.DOLLAR) continue;
      const next = level[k + 1];
      if (next && "group" in next && next.group.LPAREN()) {
        const after = level[k + 2];
        const sep = after && "token" in after && !isOp(after) && isOp(level[k + 3]) ? after : undefined;
        const op = sep ? level[k + 3] : isOp(after) ? after : undefined;
        if (onlyMetavariables(next.group)) clear(item.token.start, next.group.stop!.stop);
        else {
          clear(item.token.start, item.token.start);
          clear(next.group.start!.start, next.group.start!.start);
          clear(next.group.stop!.start, next.group.stop!.start);
          walkLevel(next.group.tokenTree());
        }
        if (sep && "token" in sep) clear(sep.token.start, sep.token.stop);
        if (op && "token" in op) clear(op.token.start, op.token.start);
        k += sep ? 3 : op ? 2 : 1;
      } else if (next && "token" in next && next.token.type === RustLexer.KW_CRATE) {
        clear(item.token.start, item.token.start);
      } else if (mode === "rename") {
        chars[item.token.start - open.start - 1] = "_";
      } else {
        clear(item.token.start, next && "token" in next ? next.token.stop : item.token.start);
      }
    }
  };
  walkLevel(group.tokenTree());
  return chars.join("");
}

/**
 * The calls in a `(…)` / `[…]` macro's arguments when they read as expressions (`assert_eq!(Club::new(1).size(),
 * 3)`, `format!("{}", user.name())`, `vec![load(id)]`), walked as any other code is; false when they do not
 * (`json!({ … })`, `matches!(x, A | B)`, `vec![0; n]`), for the token scan to read.
 */
function macroArgumentCalls(group: DelimTokenTreeContext, owner: PatternCallName[], functions: ParsedFunctionSpan[], source: Source): boolean {
  if (source.depth >= MACRO_DEPTH || !(group.LPAREN() || group.LSQUAREBRACKET())) return false;
  const open = group.start!;
  const close = group.stop!;
  if (close.start <= open.stop + 1) return true;
  const padded = "\n".repeat(open.line - 1) + " ".repeat(open.column + 1) + source.text.slice(open.start + 1, close.stop);
  let complete = false;
  const { tree, errors } = parseWithAntlr(
    padded,
    (input) => new RustLexer(input),
    (tokens) => new RustParser(tokens),
    (parser) => {
      const params = parser.callParams();
      complete = parser.inputStream.LA(1) === Token.EOF;
      return params;
    },
  );
  if (errors > 0 || !complete) return false;
  walk(tree, owner, functions, { text: padded, depth: source.depth + 1 });
  return true;
}

function walk(root: ParseTree, owner: PatternCallName[], functions: ParsedFunctionSpan[], source: Source): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    // An attribute's arguments (`#[cfg(feature = "x")]`) call nothing.
    if (ctx instanceof OuterAttributeContext || ctx instanceof InnerAttributeContext) continue;
    if (ctx instanceof Function_Context) {
      const body = ctx.blockExpression();
      const name = ctx.identifier();
      const calls: PatternCallName[] = [];
      if (body) walk(body, calls, functions, source);
      functions.push({ name: unraw(name.getText()), line: name.start!.line, endLine: ctx.stop?.line ?? name.start!.line, calls: recordPatternCalls(calls) });
      continue;
    }
    if (ctx instanceof MacroTranscriberContext) {
      functions.push(...templateItems(ctx, source));
      continue;
    }
    if (ctx instanceof MacroInvocationSemiContext) {
      const items = macroItems(ctx.children.filter((c): c is TokenTreeContext => c instanceof TokenTreeContext), source);
      if (items.length > 0) {
        functions.push(...items);
        continue;
      }
    }
    if (ctx instanceof MacroInvocationContext && macroArgumentCalls(ctx.delimTokenTree(), owner, functions, source)) continue;
    // Macro arguments that are not expressions: tokens to the parser, read as the call patterns read text.
    if (ctx.children.some((c) => c instanceof TokenTreeContext)) {
      macroCalls(terminals(ctx.children.filter((c) => c instanceof TokenTreeContext)), owner);
      continue;
    }
    if (ctx instanceof CallExpressionContext || isShaped(ctx, "call")) {
      const named = pathCallName(ctx.children[0]!);
      if (named) owner.push(named);
    } else if (ctx instanceof MethodCallExpressionContext || isShaped(ctx, "method")) {
      const named = methodCallName(ctx.children[0]!, ctx.children[2] as PathExprSegmentContext);
      if (named) owner.push(named);
    } else if (ctx instanceof BlockTailContext) {
      blockTailCalls(ctx, owner);
    }
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
}

/** `statementExpression` mirrors `expression` without labels: tell its call shapes by their children. */
function isShaped(ctx: ParserRuleContext, shape: "call" | "method"): boolean {
  if (!(ctx instanceof StatementExpressionContext)) return false;
  const [, second, third, fourth] = ctx.children;
  if (shape === "call") return second instanceof TerminalNode && second.symbol.type === RustLexer.LPAREN && isExpression(ctx.children[0]);
  return second instanceof TerminalNode && second.symbol.type === RustLexer.DOT && third instanceof PathExprSegmentContext
    && fourth instanceof TerminalNode && fourth.symbol.type === RustLexer.LPAREN;
}

function isExpression(node: ParseTree | undefined): node is ParserRuleContext {
  return node instanceof ExpressionContext || node instanceof StatementExpressionContext;
}

/** The expression an attribute stands on (`#[allow(deprecated)] self.load()`): attributes name nothing. */
function unattributed(node: ParseTree): ParseTree {
  let current = node;
  while (isExpression(current) && current.children[0] instanceof OuterAttributeContext && isExpression(current.children.at(-1))) {
    current = current.children.at(-1)!;
  }
  return current;
}

/** The first and only child an expression wraps, when it wraps one (`PathExpression_` → its path). */
function single(node: ParseTree): ParseTree | null {
  const inner = unattributed(node);
  return isExpression(inner) && inner.children.length === 1 ? inner.children[0]! : null;
}

/** A path's names with the separator before each: `Club::new` is `[Club, ::new]`. */
interface PathName {
  name: string;
  token: Token;
}

/** The names of a plain path expression (`a::b::c`, `Self::x`), or null when it is something else. */
function pathNames(node: ParseTree): PathName[] | null {
  const inner = single(node);
  const path = inner instanceof PathExpressionContext ? inner.children[0] : null;
  if (!(path instanceof PathInExpressionContext)) return null;
  return path.pathExprSegment().map((seg) => {
    const ident = seg.pathIdentSegment();
    return { name: ident.getText(), token: ident.start! };
  });
}

/** `r#try` → `try`: a raw identifier names what it spells. */
function unraw(name: string): string {
  return name.includes("r#") ? name.replace(/(^|[.:])r#/g, "$1") : name;
}

const call = (name: string, leaf: string, token: Token, receiverType?: string): PatternCallName => ({
  name: unraw(name),
  leafName: unraw(leaf),
  line: token.line,
  column: token.column,
  ...(receiverType ? { receiverType } : {}),
});

/** A call of a path: `f(`, `Club::new(` (on the type `Club`), `Self::check(`, `db::query(` (its last name). */
function pathCallName(callee: ParseTree): PatternCallName | null {
  const names = pathNames(callee);
  if (!names) {
    // `<T as Trait>::method(`: the patterns read only the method.
    const inner = single(callee);
    const qualified = inner instanceof PathExpressionContext ? inner.children[0] : null;
    if (qualified instanceof QualifiedPathInExpressionContext) {
      const last = qualified.pathExprSegment().at(-1)?.pathIdentSegment();
      return last ? call(last.getText(), last.getText(), last.start!) : null;
    }
    return null;
  }
  const leaf = names.at(-1)!;
  if (names.length === 1) return call(leaf.name, leaf.name, leaf.token);
  const owner = names.at(-2)!;
  // `Self::new(` too: the patterns' `Type::f` rule reads `Self` as a type.
  if (/^[A-Z]/.test(owner.name)) return call(`${owner.name}.${leaf.name}`, leaf.name, owner.token, owner.name);
  return call(leaf.name, leaf.name, leaf.token);
}

/** `Html(body)`: a call of a capitalized name builds a value of that tuple struct, so its methods are the type's. */
function constructedType(attributed: ParseTree): PathName | null {
  const node = unattributed(attributed);
  if (!isExpression(node) || !(node instanceof CallExpressionContext || isShaped(node, "call"))) return null;
  const names = pathNames(node.children[0]!);
  return names?.length === 1 && /^[A-Z]/.test(names[0]!.name) ? names[0]! : null;
}

/** The chain a call's result is named by — `Club.new()`, `Club.new().squad()` — and how many calls deep it is. */
function chainOf(attributed: ParseTree): { parts: string[]; token: Token } | null {
  const node = unattributed(attributed);
  if (!isExpression(node)) return null;
  if (node instanceof CallExpressionContext || isShaped(node, "call")) {
    const names = pathNames(node.children[0]!);
    if (!names || constructedType(node)) return null;
    if (names.length === 1) return { parts: [names[0]!.name], token: names[0]!.token };
    if (names.length === 2 && /^[A-Z]/.test(names[0]!.name)) return { parts: [`${names[0]!.name}.${names[1]!.name}`], token: names[0]!.token };
    return null;
  }
  if (node instanceof MethodCallExpressionContext || isShaped(node, "method")) {
    const method = unraw((node.children[2] as PathExprSegmentContext).pathIdentSegment().getText());
    const inner = chainOf(node.children[0]!);
    if (inner) return inner.parts.length >= CHAIN_DEPTH ? null : { parts: [...inner.parts, method], token: inner.token };
    // A method on a name heads a chain as the call is named (`self.repo.find(id)` is `repo.find`), so a
    // wrapped builder chain (`builder⏎.enable_time()⏎.build()`) reads as `builder.enable_time().build`, which
    // the linker types step by step through declared return types; so does one on a constructed tuple struct.
    const prev = lastName(node.children[0]!) ?? constructedType(node.children[0]!);
    return prev ? { parts: [`${prev.name}.${method}`], token: prev.token } : null;
  }
  return null;
}

/** A receiver no name spells but that ends in no call or index, so the patterns read the method alone. */
function isBareReceiver(attributed: ParseTree): boolean {
  const node = unattributed(attributed);
  if (!isExpression(node)) return false;
  const last = node.children.at(-1);
  if (last instanceof TerminalNode && (last.symbol.type === RustLexer.QUESTION || last.symbol.type === RustLexer.KW_AWAIT)) return true;
  return single(node) instanceof LiteralExpressionContext;
}

function methodCallName(receiver: ParseTree, segment: PathExprSegmentContext): PatternCallName | null {
  const leafCtx = segment.pathIdentSegment();
  const leaf = leafCtx.getText();
  // `self.repo.find(` — the last two names of a name path, through fields.
  const prev = lastName(receiver);
  if (prev) return call(`${prev.name}.${leaf}`, leaf, prev.token);
  const chain = chainOf(receiver);
  if (chain) return call(`${chain.parts.map((p) => `${p}()`).join(".")}.${leaf}`, leaf, chain.token);
  const built = constructedType(receiver);
  if (built) return call(`${built.name}.${leaf}`, leaf, built.token, built.name);
  // A struct literal names its type: `ReportQuery { … }.list(pool)` is `ReportQuery.list`.
  const literal = single(receiver);
  if (literal instanceof StructExpressionContext) {
    const type = literal.structExprStruct()?.pathInExpression().pathExprSegment().at(-1)?.getText();
    if (type) return call(`${type}.${leaf}`, leaf, leafCtx.start!, type);
  }
  return isBareReceiver(receiver) ? call(leaf, leaf, leafCtx.start!) : null;
}

/** The last name of a name path or field chain (`a::B`, `self.repo`), or null for anything else. */
function lastName(node: ParseTree): PathName | null {
  const names = pathNames(node);
  if (names) return names.at(-1)!;
  const inner = unattributed(node);
  if (!isExpression(inner)) return null;
  const [base, dot, field] = inner.children;
  if (inner.children.length === 3 && dot instanceof TerminalNode && dot.symbol.type === RustLexer.DOT && !(field instanceof TerminalNode)
    && field && (field as ParserRuleContext).ruleIndex === RustParser.RULE_identifier && base && (lastName(base) || isTupleField(base))) {
    return { name: field.getText(), token: (field as ParserRuleContext).start! };
  }
  return null;
}

/** `pool.0`, `self.0.1`: a tuple field of a name path, through which a later field still has a name. */
function isTupleField(node: ParseTree): boolean {
  const inner = unattributed(node);
  if (!isExpression(inner) || inner.children.length !== 3) return false;
  const [base, dot, index] = inner.children;
  return dot instanceof TerminalNode && dot.symbol.type === RustLexer.DOT && !(index instanceof TerminalNode)
    && (index as ParserRuleContext).ruleIndex === RustParser.RULE_tupleIndex && !!base && (lastName(base) !== null || isTupleField(base));
}

/** `match x { … }.unwrap().len()`: the first method is on the block, named alone; the rest are on calls. */
function blockTailCalls(tail: BlockTailContext, owner: PatternCallName[]): void {
  const first = tail.blockStep();
  if (first.LPAREN()) {
    const segment = first.pathExprSegment()!.pathIdentSegment();
    owner.push(call(segment.getText(), segment.getText(), segment.start!));
  }
  let afterBare = first.QUESTION() !== null || first.KW_AWAIT() !== null;
  for (const post of tail.blockPostfix()) {
    const step = post.blockStep();
    if (step?.LPAREN() && afterBare) {
      const segment = step.pathExprSegment()!.pathIdentSegment();
      owner.push(call(segment.getText(), segment.getText(), segment.start!));
    }
    afterBare = step instanceof BlockStepContext && (step.QUESTION() !== null || step.KW_AWAIT() !== null);
  }
}

function terminals(nodes: ParseTree[]): Token[] {
  const out: Token[] = [];
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) {
      out.push(node.symbol);
      continue;
    }
    const children = (node as ParserRuleContext).children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return out;
}

const NAME_TOKENS: ReadonlySet<number> = new Set([RustLexer.NON_KEYWORD_IDENTIFIER, RustLexer.RAW_IDENTIFIER, RustLexer.KW_UNION, RustLexer.KW_MACRORULES]);
const BARE_BEFORE_DOT: ReadonlySet<number> = new Set([
  RustLexer.QUESTION, RustLexer.KW_AWAIT, RustLexer.RCURLYBRACE, RustLexer.STRING_LITERAL, RustLexer.RAW_STRING_LITERAL,
  RustLexer.CHAR_LITERAL, RustLexer.INTEGER_LITERAL, RustLexer.FLOAT_LITERAL,
]);

/** Calls in a macro's tokens (`format!("{}", user.name())`, `vec![load(id)]`), by the call patterns' rules. */
function macroCalls(tokens: Token[], owner: PatternCallName[]): void {
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i]!.type !== RustLexer.LPAREN) continue;
    // A turbofish before the arguments (`parse::<u32>(`) is skipped, as the patterns blank it.
    let j = i - 1;
    if (tokens[j]!.type === RustLexer.GT) {
      let depth = 0;
      for (; j >= 0; j--) {
        if (tokens[j]!.type === RustLexer.GT) depth++;
        else if (tokens[j]!.type === RustLexer.LT && --depth === 0) break;
      }
      j -= 2; // the `<` and the `::` before it
      if (j < 0 || tokens[j + 1]?.type !== RustLexer.PATHSEP) continue;
    }
    const leaf = tokens[j];
    if (!leaf || !NAME_TOKENS.has(leaf.type)) continue;
    const name = leaf.text ?? "";
    const sep = tokens[j - 1];
    const prev = tokens[j - 2];
    let typeToken: Token | undefined = prev;
    if (sep?.type === RustLexer.PATHSEP && prev?.type === RustLexer.GT) {
      // `Vec::<u8>::new(`: the type before the turbofish.
      let k = j - 2;
      for (let depth = 0; k >= 0; k--) {
        if (tokens[k]!.type === RustLexer.GT) depth++;
        else if (tokens[k]!.type === RustLexer.LT && --depth === 0) break;
      }
      typeToken = tokens[k - 1]?.type === RustLexer.PATHSEP ? tokens[k - 2] : undefined;
    }
    if (sep?.type === RustLexer.PATHSEP && typeToken) {
      const prev = typeToken;
      if ((NAME_TOKENS.has(prev.type) || prev.type === RustLexer.KW_SELFTYPE) && /^[A-Z]/.test(prev.text ?? "")) {
        owner.push(call(`${prev.text}.${name}`, name, prev, prev.text ?? undefined));
      }
      else owner.push(call(name, name, leaf));
    } else if (sep?.type === RustLexer.DOT && prev) {
      if (NAME_TOKENS.has(prev.type) || prev.type === RustLexer.KW_SELFVALUE) owner.push(call(`${prev.text}.${name}`, name, prev));
      else if (BARE_BEFORE_DOT.has(prev.type)) owner.push(call(name, name, leaf));
    } else if (sep?.type !== RustLexer.NOT) {
      owner.push(call(name, name, leaf));
    }
  }
}
