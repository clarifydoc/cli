import type { Node } from "web-tree-sitter";
import { callChainText } from "../../shared/call-graph.js";
import { unwrapExpression } from "./local-types.js";

/**
 * The `.Result` reads of an async method's body (`FunctionInfo.propertyReads`): `task.Result`, `this.pending.Result`,
 * `repo.FindAsync().Result` — the receiver a name, `this.field` or a call chain, so core can judge its type. Only that
 * one member is read (a `Result` property of a project class is told apart by the receiver's declared type, not
 * here), and none of these states anything:
 *   - a read inside a lambda or a local function — `task.ContinueWith(t => t.Result)` runs once the task is done;
 *   - a read of a name the body awaits (`await Task.WhenAll(a, b); a.Result`) — the task is complete there;
 *   - a conditional access (`task?.Result`) or any other receiver.
 */
export function csharpPropertyReads(body: Node | null): Array<{ name: string; line: number }> | undefined {
  if (!body || !body.text.includes(".Result")) return undefined;
  const found: Array<{ name: string; line: number }> = [];
  const awaited = awaitedNames(body);
  for (const node of body.descendantsOfType("member_access_expression")) {
    if (node.childForFieldName("name")?.text !== "Result") continue;
    if (insideDeferredScope(node, body)) continue;
    const receiver = node.childForFieldName("expression");
    if (!receiver) continue;
    const target = unwrapExpression(receiver);
    let text: string | null = null;
    if (target.type === "identifier") text = awaited.has(target.text) ? null : target.text;
    else if (target.type === "member_access_expression" && target.childForFieldName("expression")?.type === "this") {
      const field = target.childForFieldName("name")?.text;
      text = field && !awaited.has(field) ? `this.${field}` : null;
    } else if (target.type === "invocation_expression") text = callChainText(target, "csharp");
    if (!text) continue;
    found.push({ name: `${text}.Result`, line: node.startPosition.row + 1 });
  }
  return found.length > 0 ? found : undefined;
}

/** Every identifier a body's `await` expressions mention: a task awaited anywhere is no blocking read afterwards. */
function awaitedNames(body: Node): Set<string> {
  const out = new Set<string>();
  for (const aw of body.descendantsOfType("await_expression")) {
    for (const id of aw.descendantsOfType("identifier")) out.add(id.text);
  }
  return out;
}

function insideDeferredScope(node: Node, body: Node): boolean {
  for (let p = node.parent; p && p.id !== body.id; p = p.parent) {
    if (p.type === "lambda_expression" || p.type === "anonymous_method_expression" || p.type === "local_function_statement") return true;
  }
  return false;
}
