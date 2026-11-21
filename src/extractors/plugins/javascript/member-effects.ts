import type { Node } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";

/** Scopes whose `this` and locals are not the function's own. An arrow function keeps both, so it is walked. */
const OWN_SCOPE_BREAKS: ReadonlySet<string> = new Set([
  "function_expression", "function", "function_declaration", "generator_function", "generator_function_declaration",
  "method_definition", "class_body", "class", "class_declaration",
]);

/** Most facts one function states: a generated initializer would otherwise swell the file for no reader. */
const MAX_FACTS = 40;

type Effects = Pick<FunctionInfo, "fieldWrites" | "throws">;

/** `this`, `this.field`, or a plain name; anything else (`a.b.c`, a call, a subscript) states no receiver. */
function receiverText(n: Node | null | undefined, typed: ReadonlySet<string>): string | null {
  if (!n) return null;
  if (n.type === "this") return "this";
  if (n.type === "identifier") return typed.has(n.text) ? n.text : null;
  if (n.type === "member_expression") {
    const obj = n.childForFieldName("object");
    const prop = n.childForFieldName("property");
    if (obj?.type === "this" && prop?.type === "property_identifier") return `this.${prop.text}`;
  }
  return null;
}

/**
 * What a function body writes to members and throws (`FunctionInfo.fieldWrites` / `throws`): `x.m = …`, `x.m += …`,
 * `x.m++` where `x` is `this`, `this.field` or a parameter/local with a declared type, and `throw new T(…)`.
 * `typed` names the parameters and locals whose type the function states; a receiver outside that set is never
 * stated (an untyped `obj.x = 1` could be any object). Pass `initializer: true` for an initializer: it states no writes.
 */
export function memberEffectsOf(
  body: Node | null,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
  options: { initializer?: boolean; skip?: (node: Node) => boolean } = {},
): Effects | null {
  if (!body) return null;
  const typed = new Set<string>(localNames);
  for (const p of params) if (p.type) typed.add(p.name);
  const writes: NonNullable<Effects["fieldWrites"]> = [];
  const throws: NonNullable<Effects["throws"]> = [];
  const seen = new Set<string>();
  const addWrite = (target: Node | null | undefined, at: Node): void => {
    if (options.initializer || target?.type !== "member_expression" || writes.length >= MAX_FACTS) return;
    const prop = target.childForFieldName("property");
    if (prop?.type !== "property_identifier") return;
    const receiver = receiverText(target.childForFieldName("object"), typed);
    if (receiver === null) return;
    const line = at.startPosition.row + 1;
    const key = `${receiver}.${prop.text}@${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    writes.push({ member: prop.text, receiver, line });
  };
  const visit = (n: Node, root: boolean): void => {
    if (!root && (OWN_SCOPE_BREAKS.has(n.type) || options.skip?.(n))) return;
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") addWrite(n.childForFieldName("left"), n);
    else if (n.type === "update_expression") addWrite(n.childForFieldName("argument"), n);
    else if (n.type === "throw_statement" && throws.length < MAX_FACTS) {
      const thrown = n.namedChildren.find((c) => c.type !== "comment");
      const ctor = thrown?.type === "new_expression" ? thrown.childForFieldName("constructor") : null;
      if (ctor && (ctor.type === "identifier" || ctor.type === "member_expression") && /^[\w$.]+$/.test(ctor.text)) {
        throws.push({ type: ctor.text, line: n.startPosition.row + 1 });
      }
    }
    for (const c of n.namedChildren) visit(c, false);
  };
  visit(body, true);
  if (writes.length === 0 && throws.length === 0) return null;
  return { ...(writes.length > 0 ? { fieldWrites: writes } : {}), ...(throws.length > 0 ? { throws } : {}) };
}
