import type { Node } from "web-tree-sitter";
import { namesReceiverType } from "./di.js";

/** Where a function's own scope ends: a narrowing never reaches across one (a callback may run after the name changed). */
const SCOPE_BOUNDARIES: ReadonlySet<string> = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "generator_function",
  "arrow_function", "method_definition", "class_body", "program",
]);

const mentionsInstanceof = new WeakMap<object, boolean>();

/** Statements after which control never reaches the next one in the block. */
const TERMINATORS: ReadonlySet<string> = new Set(["return_statement", "throw_statement", "continue_statement", "break_statement"]);

function unwrap(node: Node | null | undefined): Node | null {
  let n = node ?? null;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  return n;
}

function operatorOf(node: Node): string | null {
  return node.childForFieldName("operator")?.text ?? null;
}

/** The class `name instanceof Class` states, through `&&` (positive) — null when the test says nothing certain. */
function positive(cond: Node | null | undefined, name: string): string | null {
  const c = unwrap(cond);
  if (!c || c.type !== "binary_expression") return null;
  const op = operatorOf(c);
  if (op === "&&") return positive(c.childForFieldName("left"), name) ?? positive(c.childForFieldName("right"), name);
  if (op !== "instanceof") return null;
  const left = unwrap(c.childForFieldName("left"));
  const right = c.childForFieldName("right");
  if (left?.type !== "identifier" || left.text !== name || right?.type !== "identifier") return null;
  return namesReceiverType(right.text) ? right.text : null;
}

/** The class a FALSE `cond` leaves `name` as: `!(name instanceof Class)`, through `||`. */
function negative(cond: Node | null | undefined, name: string): string | null {
  const c = unwrap(cond);
  if (!c) return null;
  if (c.type === "binary_expression" && operatorOf(c) === "||") {
    return negative(c.childForFieldName("left"), name) ?? negative(c.childForFieldName("right"), name);
  }
  if (c.type !== "unary_expression" || operatorOf(c) !== "!") return null;
  return positive(c.childForFieldName("argument"), name);
}

/** Does anything in [from, to) assign the name (a rebind ends the narrowing)? */
function reassigned(scope: Node, name: string, from: number, to: number): boolean {
  const stack: Node[] = [scope];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.endIndex <= from || n.startIndex >= to) continue;
    if ((n.type === "assignment_expression" || n.type === "augmented_assignment_expression") && n.childForFieldName("left")?.text === name) return true;
    if (n.type === "update_expression" && n.childForFieldName("argument")?.text === name) return true;
    for (const k of n.namedChildren) if (k) stack.push(k);
  }
  return false;
}

function terminates(stmt: Node | null | undefined): boolean {
  if (!stmt) return false;
  if (TERMINATORS.has(stmt.type)) return true;
  if (stmt.type !== "statement_block") return false;
  const last = stmt.namedChildren[stmt.namedChildren.length - 1];
  return !!last && TERMINATORS.has(last.type);
}

/**
 * `if (x instanceof Club) { x.sign() }` — the receiver `x` of a call in the true branch is a `Club`; likewise the `else` of
 * `if (!(x instanceof Club))`, the statements after an early exit `if (!(x instanceof Club)) return;`, the right side of
 * `x instanceof Club && x.sign()` and the consequence of `x instanceof Club ? x.sign() : …`. Never across a function
 * boundary, and not after the name is assigned in between. The nearest narrowing wins; no union of tests is guessed.
 */
export function instanceofNarrowedType(call: Node, name: string): { type: string } | null {
  let seen = mentionsInstanceof.get(call.tree);
  if (seen === undefined) {
    seen = call.tree.rootNode.text.includes("instanceof");
    mentionsInstanceof.set(call.tree, seen);
  }
  if (!seen) return null;
  const at = call.startIndex;
  let child: Node = call;
  for (let cur = call.parent; cur; child = cur, cur = cur.parent) {
    const t = cur.type;
    if (SCOPE_BOUNDARIES.has(t)) return null;
    let found: string | null = null;
    let from = cur.startIndex;
    if (t === "if_statement" || t === "ternary_expression") {
      const cond = cur.childForFieldName("condition");
      if (cur.childForFieldName("consequence")?.id === child.id) found = positive(cond, name);
      else if (cur.childForFieldName("alternative")?.id === child.id) found = negative(cond, name);
      from = child.startIndex;
    } else if (t === "binary_expression" && operatorOf(cur) === "&&" && cur.childForFieldName("right")?.id === child.id) {
      found = positive(cur.childForFieldName("left"), name);
      from = child.startIndex;
    } else if (t === "statement_block") {
      // An early exit before the call's statement: `if (!(x instanceof Club)) return;`.
      for (const stmt of cur.namedChildren) {
        if (!stmt || stmt.id === child.id) break;
        if (stmt.type !== "if_statement" || stmt.childForFieldName("alternative")) continue;
        if (!terminates(stmt.childForFieldName("consequence"))) continue;
        const type = negative(stmt.childForFieldName("condition"), name);
        if (type && !reassigned(cur, name, stmt.endIndex, at)) found = type;
      }
      from = at;
    }
    if (found && !reassigned(cur, name, from, at)) return { type: found };
  }
  return null;
}
