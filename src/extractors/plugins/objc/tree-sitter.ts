import type { ParsedFunctionSpan, ParsedStructure } from "../../../types/language-plugin.js";
import type { TSNode } from "../../../parsers/parser-manager.js";
import { recordPatternCalls, type PatternCallName } from "../shared/antlr-calls.js";
import { nameCall, type CalleeStep } from "../shared/callee-names.js";
import { countSyntaxErrors, treeSitterReader } from "../shared/tree-sitter-front-end.js";

/** How many calls deep a chain is named (the linker types each step through declared return types). */
const CHAIN_DEPTH = 8;

/** The messages that make an instance of their receiver class: `[[Club alloc] init…]`, `[Club new]`. */
const CONSTRUCTING: ReadonlySet<string> = new Set(["alloc", "new"]);

/** The Objective-C front end of the `tree-sitter:objc` feature, loaded on first use. */
export function loadObjcReader(): Promise<(source: string) => ParsedStructure> {
  return treeSitterReader("objc", readObjcTree);
}

interface Walk {
  functions: Array<{ span: Omit<ParsedFunctionSpan, "calls">; calls: PatternCallName[] }>;
}

/**
 * Objective-C's functions and calls from a tree-sitter-objc tree. A function is a method (`- (void)loadClub:(…)…`,
 * named by its selector's first piece, as the patterns name it) or a C function, spanning its first line to its
 * body's `}`, and owns the calls in its body; a block's calls are its owner's. A message send is named by its
 * receiver and its selector's first piece: `[repo findClub:id]` is `repo.findClub`, as the patterns name it, and so is
 * a send the patterns cannot read — on a property path (`[self.repo findClub:]` is `repo.findClub`, its last two
 * names), on a construction (`[[Club alloc] initWithName:…]` is `Club.initWithName` on `Club`), on another send's
 * result (the chain from its first send, `ClubService.shared().refresh`), or nested in an argument. A C call is its
 * function's name, a called block property (`self.onRefresh(YES)`) its last two names; a dot-syntax property read is
 * no call.
 */
export function readObjcTree(root: TSNode): ParsedStructure {
  const walk: Walk = { functions: [] };
  visit(root, null, walk);
  walk.functions.sort((a, b) => a.span.line - b.span.line);
  return {
    functions: walk.functions.map(({ span, calls }) => ({ ...span, calls: recordPatternCalls(calls) })),
    topLevelCalls: [],
    syntaxErrors: countSyntaxErrors(root),
  };
}

function visit(node: TSNode, owner: PatternCallName[] | null, walk: Walk): void {
  for (let i = 0; i < node.namedChildCount; i++) visitNode(node.namedChild(i)!, owner, walk);
}

function visitNode(node: TSNode, owner: PatternCallName[] | null, walk: Walk): void {
  const name = node.type === "method_definition" ? methodName(node) : node.type === "function_definition" ? functionName(node) : undefined;
  if (name !== undefined) {
    const calls: PatternCallName[] = [];
    if (name) walk.functions.push({ span: { name: name.text, line: node.startPosition.row + 1, endLine: node.endPosition.row + 1 }, calls });
    visit(node, calls, walk);
    return;
  }
  if (owner && node.type === "message_expression") {
    // At its `[`, where the patterns place a send.
    const named = nameCall(sendSteps(node), CHAIN_DEPTH);
    if (named) owner.push({ ...named, line: node.startPosition.row + 1, column: node.startPosition.column });
  } else if (owner && node.type === "call_expression") {
    // `helper(c)`, and a block property called (`self.onRefresh(YES)`) by its last two names.
    const fn = node.childForFieldName("function");
    const named = fn ? nameCall(receiverSteps(fn), CHAIN_DEPTH) : null;
    if (named) owner.push(named);
  }
  visit(node, owner, walk);
}

/** A method's name: its selector's first piece. */
function methodName(node: TSNode): TSNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === "identifier") return child;
  }
  return null;
}

/** A C function's name, through its pointer and function declarators. */
function functionName(node: TSNode): TSNode | null {
  let declarator = node.childForFieldName("declarator");
  while (declarator && declarator.type !== "identifier") declarator = declarator.childForFieldName("declarator");
  return declarator;
}

const idStep = (name: string, node: TSNode): CalleeStep => ({ kind: "id", name, line: node.startPosition.row + 1, column: node.startPosition.column });

/** A send's callee as steps: its receiver's, then its selector's first piece. */
function sendSteps(node: TSNode): CalleeStep[] {
  const method = node.childForFieldName("method");
  const receiver = node.childForFieldName("receiver");
  if (!method || !receiver) return [{ kind: "other", bare: false }];
  return [...receiverSteps(receiver), idStep(method.text, method)];
}

function receiverSteps(node: TSNode): CalleeStep[] {
  switch (node.type) {
    case "identifier":
    case "self":
    case "super":
      return [idStep(node.text, node)];
    case "field_expression": {
      const argument = node.childForFieldName("argument");
      const field = node.childForFieldName("field");
      if (!argument || !field) return [{ kind: "other", bare: false }];
      return [...receiverSteps(argument), idStep(field.text, field)];
    }
    case "message_expression": {
      const method = node.childForFieldName("method");
      const receiver = node.childForFieldName("receiver");
      // `[[Club alloc] initWithName:…]`: the send is made on a new `Club`.
      if (method && receiver?.type === "identifier" && CONSTRUCTING.has(method.text) && /^[A-Z]/.test(receiver.text)) {
        return [idStep(receiver.text, receiver), { kind: "call", constructs: receiver.text }];
      }
      return [...sendSteps(node), { kind: "call" }];
    }
    case "parenthesized_expression": {
      const inner = node.namedChild(0);
      return inner ? receiverSteps(inner) : [{ kind: "other", bare: false }];
    }
    default:
      return [{ kind: "other", bare: false }];
  }
}
