import type { Node } from "web-tree-sitter";
import { callChainText } from "../../shared/call-graph.js";
import { argumentsOf, unwrapExpression } from "./local-types.js";

/**
 * The `.Result` reads of an async method's body (`FunctionInfo.propertyReads`): `task.Result`, `this.pending.Result`,
 * `repo.FindAsync().Result` — the receiver a name, `this.field` or a call chain, so core can judge its type. Only that
 * one member is read (a `Result` property of a project class is told apart by the receiver's declared type, not
 * here), and none of these states anything:
 *   - a read inside a lambda or a local function — `task.ContinueWith(t => t.Result)` runs once the task is done;
 *   - a read of a name the body awaited EARLIER (`await a;`, `await Task.WhenAll(a, b); a.Result`) — the task is
 *     complete there; a name only mentioned in an await (`await Log(a.Id)`) is no such task;
 *   - a conditional access (`task?.Result`) or any other receiver.
 */
export function csharpPropertyReads(body: Node | null): Array<{ name: string; line: number }> | undefined {
  if (!body || !fileMentionsResult(body) || !body.text.includes(".Result")) return undefined;
  const found: Array<{ name: string; line: number }> = [];
  let awaitedMemo: Map<string, number> | undefined;
  const awaited = () => (awaitedMemo ??= awaitedNames(body));
  for (const node of body.descendantsOfType("member_access_expression")) {
    if (node.childForFieldName("name")?.text !== "Result") continue;
    if (insideDeferredScope(node, body)) continue;
    const receiver = node.childForFieldName("expression");
    if (!receiver) continue;
    const target = unwrapExpression(receiver);
    let text: string | null = null;
    if (target.type === "identifier") text = doneBefore(awaited(), target.text, node.startIndex) ? null : target.text;
    else if (target.type === "member_access_expression" && target.childForFieldName("expression")?.type === "this") {
      const field = target.childForFieldName("name")?.text;
      text = field && !doneBefore(awaited(), field, node.startIndex) ? `this.${field}` : null;
    } else if (target.type === "invocation_expression") text = callChainText(target, "csharp");
    if (!text) continue;
    found.push({ name: `${text}.Result`, line: node.startPosition.row + 1 });
  }
  return found.length > 0 ? found : undefined;
}

/** Whether the file mentions `.Result` at all: asked once per parse tree, not once per async method. */
const MENTIONS = new WeakMap<object, boolean>();
function fileMentionsResult(body: Node): boolean {
  let hit = MENTIONS.get(body.tree);
  if (hit === undefined) MENTIONS.set(body.tree, (hit = body.tree.rootNode.text.includes(".Result")));
  return hit;
}

/**
 * The tasks a body's `await` expressions complete, with where each await ends: `await task`, `await task.ConfigureAwait(false)`,
 * `await this.task`, and the plain names handed to `Task.WhenAll` / `WhenAny` / `WaitAll` inside one. Only the first await
 * of a name is kept (the earliest point the task is known complete).
 */
function awaitedNames(body: Node): Map<string, number> {
  const out = new Map<string, number>();
  const note = (name: string | undefined, end: number): void => {
    if (name && (out.get(name) ?? Infinity) > end) out.set(name, end);
  };
  const plainName = (n: Node): string | undefined => {
    const t = unwrapExpression(n);
    if (t.type === "identifier") return t.text;
    if (t.type === "member_access_expression" && t.childForFieldName("expression")?.type === "this") return t.childForFieldName("name")?.text;
    return undefined;
  };
  for (const aw of body.descendantsOfType("await_expression")) {
    let inner = aw.namedChild(0);
    if (!inner) continue;
    inner = unwrapExpression(inner);
    const callee = inner.type === "invocation_expression" ? inner.childForFieldName("function") : null;
    if (callee?.type === "member_access_expression") {
      const member = callee.childForFieldName("name")?.text;
      if (member === "ConfigureAwait") {
        const target = callee.childForFieldName("expression");
        if (target) note(plainName(target), aw.endIndex);
      } else if (member === "WhenAll" || member === "WhenAny" || member === "WaitAll") {
        for (const arg of argumentsOf(inner)) note(plainName(arg.expr), aw.endIndex);
      }
    } else note(plainName(inner), aw.endIndex);
  }
  return out;
}

const doneBefore = (awaited: Map<string, number>, name: string, at: number): boolean => (awaited.get(name) ?? Infinity) <= at;

function insideDeferredScope(node: Node, body: Node): boolean {
  for (let p = node.parent; p && p.id !== body.id; p = p.parent) {
    if (p.type === "lambda_expression" || p.type === "anonymous_method_expression" || p.type === "local_function_statement") return true;
  }
  return false;
}
