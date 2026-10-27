import { TerminalNode, type ParserRuleContext, type ParseTree } from "antlr4ng";
import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import { LuaLexer } from "../../../parsers/antlr/lua/LuaLexer.js";
import {
  LuaParser,
  ArgsContext,
  ExpContext,
  FuncbodyContext,
  FunctioncallContext,
  FunctiondefContext,
  StatContext,
} from "../../../parsers/antlr/lua/LuaParser.js";
import { parseWithAntlr } from "../../../parsers/antlr/run.js";
import { patternCallName, recordPatternCalls, type CalleeSegment, type PatternCallName } from "../shared/antlr-calls.js";

/** A name a function is declared or assigned under: `M.connect`, `Pool:get`, `helper`. */
const FUNCTION_NAME = /^[A-Za-z_][\w.]*(?::[A-Za-z_]\w*)?$/;

/**
 * Lua's functions and calls as the grammars-v4 Lua 5.4 grammar reads them (the `antlr:lua` feature). A
 * function is a `function name` / `local function name` statement, or a function expression assigned to a
 * name (`M.load = function(…)`, `local f = function(…)`), spanning its statement to its `end`; it owns the
 * calls in its body except those of a function declared inside it, while an anonymous function's calls
 * stay its owner's. Calls include the ones Lua writes without parentheses — `require "x"`, `f{…}`.
 */
export function readLua(source: string): ParsedStructure {
  const { tree, errors } = parseWithAntlr(
    source,
    (input) => new LuaLexer(input),
    (tokens) => new LuaParser(tokens),
    (parser) => parser.start_(),
  );
  const functions: ParsedFunctionSpan[] = [];
  const topLevel: PatternCallName[] = [];
  walk(tree, topLevel, functions);
  functions.sort((a, b) => a.line - b.line);
  return { functions, topLevelCalls: recordPatternCalls(topLevel), syntaxErrors: errors };
}

function walk(root: ParseTree, owner: PatternCallName[], functions: ParsedFunctionSpan[]): void {
  const stack: ParseTree[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node instanceof TerminalNode) continue;
    const ctx = node as ParserRuleContext;
    if (ctx instanceof StatContext) {
      const declared = declaredFunction(ctx);
      if (declared) {
        const calls: PatternCallName[] = [];
        walk(declared.body, calls, functions);
        functions.push({
          name: declared.name,
          line: ctx.start!.line,
          endLine: declared.body.stop?.line ?? ctx.start!.line,
          ...(declared.local ? { isExported: false } : {}),
          calls: recordPatternCalls(calls),
        });
        continue;
      }
    }
    if (ctx instanceof FunctioncallContext) callsOf(ctx, owner);
    for (let i = ctx.children.length - 1; i >= 0; i--) stack.push(ctx.children[i]!);
  }
}

/** The function a statement declares or assigns to one name, with its body. */
function declaredFunction(stat: StatContext): { name: string; body: FuncbodyContext; local: boolean } | null {
  const first = stat.children[0];
  if (!(first instanceof TerminalNode)) {
    // `name = function(…) … end`
    const vars = stat.varlist()?.var_();
    const exps = stat.explist()?.exp();
    if (vars?.length !== 1 || exps?.length !== 1) return null;
    const body = functionExpression(exps[0]!);
    const name = vars[0]!.getText();
    return body && FUNCTION_NAME.test(name) ? { name, body, local: false } : null;
  }
  const kind = first.symbol.type;
  if (kind === LuaLexer.FUNCTION) {
    const name = stat.funcname()?.getText();
    const body = stat.funcbody();
    return name && body ? { name, body, local: false } : null;
  }
  if (kind !== LuaLexer.LOCAL) return null;
  if (stat.FUNCTION()) {
    const name = stat.NAME()?.getText();
    const body = stat.funcbody();
    return name && body ? { name, body, local: true } : null;
  }
  // `local f = function(…) … end`
  const names = stat.attnamelist()?.NAME();
  const exps = stat.explist()?.exp();
  if (names?.length !== 1 || exps?.length !== 1) return null;
  const body = functionExpression(exps[0]!);
  return body ? { name: names[0]!.getText(), body, local: true } : null;
}

function functionExpression(exp: ExpContext): FuncbodyContext | null {
  const def = exp.children.length === 1 ? exp.children[0] : null;
  return def instanceof FunctiondefContext ? def.funcbody() : null;
}

/**
 * `functioncall: (NAME | '(' exp ')') ('[' exp ']' | '.' NAME)* (args | ':' NAME args) …`: each argument list
 * is a call of the steps before it.
 */
function callsOf(ctx: FunctioncallContext, out: PatternCallName[]): void {
  const segments: CalleeSegment[] = [];
  let colon = false;
  for (const child of ctx.children) {
    if (child instanceof ArgsContext) {
      const named = patternCallName(segments, 0);
      if (named) out.push(named);
      segments.push({ kind: "call" });
      continue;
    }
    if (!(child instanceof TerminalNode)) continue;
    const token = child.symbol;
    switch (token.type) {
      case LuaLexer.NAME:
        segments.push({ kind: "id", name: token.text ?? "", line: token.line, column: token.column, ...(colon ? { colon: true } : {}) });
        colon = false;
        break;
      case LuaLexer.COL:
        colon = true;
        break;
      case LuaLexer.OP:
      case LuaLexer.OB:
        segments.push({ kind: "other" });
        break;
    }
  }
}
