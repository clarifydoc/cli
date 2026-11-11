import type { Node } from "web-tree-sitter";

/** Where a member's own scope ends: a narrowing never reaches into a lambda (it may run after the name changed). */
const SCOPE_BOUNDARIES: ReadonlySet<string> = new Set([
  "method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "accessor_declaration",
  "local_function_statement", "lambda_expression", "anonymous_method_expression", "class_declaration", "struct_declaration",
  "record_declaration", "interface_declaration", "compilation_unit",
]);

const TERMINATORS: ReadonlySet<string> = new Set(["return_statement", "throw_statement", "continue_statement", "break_statement"]);

const mentionsIs = new WeakMap<object, boolean>();

function unwrap(node: Node | null | undefined): Node | null {
  let n = node ?? null;
  while (n?.type === "parenthesized_expression") n = n.namedChild(0);
  return n;
}

/** The class a type-test pattern names: `Club` (a constant pattern the grammar cannot tell from a type), `Club c`, `Club { … }`. */
function patternClass(pattern: Node | null | undefined): string | null {
  if (!pattern) return null;
  let name: string | null = null;
  if (pattern.type === "constant_pattern") {
    const inner = pattern.namedChild(0);
    name = inner?.type === "identifier" ? inner.text : null;
  } else if (pattern.type === "declaration_pattern" || pattern.type === "recursive_pattern") {
    const type = pattern.childForFieldName("type");
    name = type?.type === "identifier" ? type.text : null;
  }
  return name && /^[A-Z]\w*$/.test(name) && name !== "null" ? name : null;
}

/** `name is Club`, through `&&` (the condition holds, so every conjunct does). */
function positive(cond: Node | null | undefined, name: string): string | null {
  const c = unwrap(cond);
  if (!c) return null;
  if (c.type === "binary_expression" && c.childForFieldName("operator")?.text === "&&") {
    return positive(c.childForFieldName("left"), name) ?? positive(c.childForFieldName("right"), name);
  }
  if (c.type !== "is_pattern_expression") return null;
  if (c.childForFieldName("expression")?.text !== name) return null;
  return patternClass(c.childForFieldName("pattern"));
}

/** What a FALSE condition leaves: `!(name is Club)` and `name is not Club`, through `||`. */
function negative(cond: Node | null | undefined, name: string): string | null {
  const c = unwrap(cond);
  if (!c) return null;
  if (c.type === "binary_expression" && c.childForFieldName("operator")?.text === "||") {
    return negative(c.childForFieldName("left"), name) ?? negative(c.childForFieldName("right"), name);
  }
  if (c.type === "prefix_unary_expression" && c.child(0)?.text === "!") return positive(c.namedChild(0), name);
  if (c.type === "is_pattern_expression" && c.childForFieldName("expression")?.text === name) {
    const pattern = c.childForFieldName("pattern");
    if (pattern?.type === "negated_pattern") return patternClass(pattern.namedChild(0));
  }
  return null;
}

function reassigned(scope: Node, name: string, from: number, to: number): boolean {
  const stack: Node[] = [scope];
  while (stack.length) {
    const n = stack.pop()!;
    if (n.endIndex <= from || n.startIndex >= to) continue;
    if (n.type === "assignment_expression" && n.childForFieldName("left")?.text === name) return true;
    for (const k of n.namedChildren) if (k) stack.push(k);
  }
  return false;
}

function terminates(stmt: Node | null | undefined): boolean {
  if (!stmt) return false;
  if (TERMINATORS.has(stmt.type)) return true;
  if (stmt.type !== "block") return false;
  const last = stmt.namedChildren[stmt.namedChildren.length - 1];
  return !!last && TERMINATORS.has(last.type);
}

/**
 * `if (x is Club) { x.Sign(); }` — the receiver `x` of a call in the true branch is a `Club` (a call through the
 * pattern's own name, `x is Club c` → `c.Sign()`, is typed by the local). Also the `else` of `!(x is Club)` / `x is not Club`,
 * the statements after an early exit `if (x is not Club) return;`, the right side of `x is Club && x.Sign()` and the
 * consequence of `x is Club ? x.Sign() : …`. Never into a lambda; not after `x` is assigned in between.
 */
export function typeTestNarrowedType(call: Node, name: string): { type: string } | null {
  let seen = mentionsIs.get(call.tree);
  if (seen === undefined) {
    seen = /\bis\b/.test(call.tree.rootNode.text);
    mentionsIs.set(call.tree, seen);
  }
  if (!seen) return null;
  const at = call.startIndex;
  let child: Node = call;
  for (let cur = call.parent; cur; child = cur, cur = cur.parent) {
    const t = cur.type;
    if (SCOPE_BOUNDARIES.has(t)) return null;
    let found: string | null = null;
    let from = cur.startIndex;
    if (t === "if_statement" || t === "conditional_expression") {
      const cond = cur.childForFieldName("condition");
      if (cur.childForFieldName("consequence")?.id === child.id) found = positive(cond, name);
      else if (cur.childForFieldName("alternative")?.id === child.id) found = negative(cond, name);
      from = child.startIndex;
    } else if (t === "binary_expression" && cur.childForFieldName("operator")?.text === "&&" && cur.childForFieldName("right")?.id === child.id) {
      found = positive(cur.childForFieldName("left"), name);
      from = child.startIndex;
    } else if (t === "block") {
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
