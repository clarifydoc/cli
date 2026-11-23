import type { Node } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";

/** Most facts one method states. */
const MAX_FACTS = 40;

type Effects = Pick<FunctionInfo, "fieldWrites" | "throws">;

/** Names the method declares itself (parameters, locals, `out var`, pattern variables, catch and loop variables, lambda parameters). */
function declaredNames(body: Node): Set<string> {
  const out = new Set<string>();
  for (const n of body.descendantsOfType(["variable_declarator", "parameter", "single_variable_designation", "catch_declaration", "foreach_statement"])) {
    const id = n.type === "foreach_statement"
      ? n.childForFieldName("left")
      : n.childForFieldName("name") ?? n.namedChildren.find((c) => c.type === "identifier");
    if (id?.type === "identifier") out.add(id.text);
  }
  for (const n of body.descendantsOfType("lambda_expression")) {
    const p = n.childForFieldName("parameters") ?? n.namedChildren.find((c) => c.type === "identifier");
    if (p?.type === "identifier") out.add(p.text);
  }
  return out;
}

interface Target { receiver: string; member: string }

/** `this.x` / `a.x` / `this.a.x` / bare `x`. */
function target(left: Node | null | undefined, typed: ReadonlySet<string>, locals: ReadonlySet<string>): Target | null {
  if (!left) return null;
  if (left.type === "identifier") return locals.has(left.text) ? null : { receiver: "", member: left.text };
  if (left.type !== "member_access_expression") return null;
  const member = left.childForFieldName("name");
  const obj = left.childForFieldName("expression");
  if (member?.type !== "identifier" || !obj) return null;
  if (obj.type === "this_expression" || obj.type === "this") return { receiver: "this", member: member.text };
  if (obj.type === "identifier") return typed.has(obj.text) ? { receiver: obj.text, member: member.text } : null;
  if (obj.type === "member_access_expression") {
    const head = obj.childForFieldName("expression");
    const field = obj.childForFieldName("name");
    if ((head?.type === "this_expression" || head?.type === "this") && field?.type === "identifier") return { receiver: `this.${field.text}`, member: member.text };
  }
  return null;
}

/** The type a `new T(…)` names, as written without type arguments; `null` for anything else. */
function thrownType(n: Node | null | undefined): string | null {
  if (!n || (n.type !== "object_creation_expression" && n.type !== "implicit_object_creation_expression")) return null;
  const type = n.childForFieldName("type");
  if (!type) return null;
  const head = type.type === "generic_name" ? type.namedChildren[0] : type;
  const text = head?.text.replace(/\s+/g, "").replace(/^global::/, "");
  return text && /^[\w.]+$/.test(text) ? text : null;
}

/**
 * What a C# method writes to fields/properties and throws (`FunctionInfo.fieldWrites` / `throws`): assignments,
 * compound assignments and `++`/`--` on `this.x`, a bare member `x` the method does not declare, `this.field.x` and a
 * typed parameter or local's `p.x`; `throw new T(…)` (statement or expression). `throw;` and a thrown variable state
 * nothing. A constructor states no writes — it initializes. Local functions and lambdas keep `this` and are walked.
 */
export function csharpMemberEffects(
  node: Node,
  body: Node | null,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
): Effects | null {
  if (!body) return null;
  const typed = new Set<string>(localNames);
  for (const p of params) if (p.type) typed.add(p.name);
  const locals = declaredNames(body);
  for (const p of params) locals.add(p.name);
  const initializer = node.type === "constructor_declaration";
  const writes: NonNullable<Effects["fieldWrites"]> = [];
  const throws: NonNullable<Effects["throws"]> = [];
  const addWrite = (t: Target | null, at: Node): void => {
    if (initializer || !t || writes.length >= MAX_FACTS) return;
    const line = at.startPosition.row + 1;
    if (writes.some((w) => w.receiver === t.receiver && w.member === t.member && w.line === line)) return;
    writes.push({ member: t.member, receiver: t.receiver, line });
  };
  const visit = (n: Node, root: boolean): void => {
    if (!root && (n.type === "class_declaration" || n.type === "record_declaration" || n.type === "struct_declaration")) return;
    switch (n.type) {
      case "assignment_expression":
        addWrite(target(n.childForFieldName("left"), typed, locals), n);
        break;
      case "postfix_unary_expression":
      case "prefix_unary_expression":
        if (n.children.some((c) => c.type === "++" || c.type === "--")) addWrite(target(n.namedChildren[0], typed, locals), n);
        break;
      case "throw_statement":
      case "throw_expression": {
        const type = thrownType(n.namedChildren.find((c) => c.type !== "comment"));
        if (type && throws.length < MAX_FACTS) throws.push({ type, line: n.startPosition.row + 1 });
        break;
      }
    }
    for (const c of n.namedChildren) visit(c, false);
  };
  visit(body, true);
  if (writes.length === 0 && throws.length === 0) return null;
  return { ...(writes.length > 0 ? { fieldWrites: writes } : {}), ...(throws.length > 0 ? { throws } : {}) };
}
