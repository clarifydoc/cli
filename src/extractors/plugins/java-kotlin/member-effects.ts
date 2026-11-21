import type { Node } from "web-tree-sitter";
import type { FunctionInfo, ParamInfo } from "../../../types/analysis.js";

/** Declarations whose members are not the method's own: a local or anonymous class. A lambda keeps `this` and is walked. */
const OWN_SCOPE_BREAKS: ReadonlySet<string> = new Set(["class_body", "class_declaration", "object_declaration", "anonymous_initializer", "enum_body"]);

/** Most facts one method states. */
const MAX_FACTS = 40;

type Effects = Pick<FunctionInfo, "fieldWrites" | "throws">;

/** The type a `throw new X<…>(…)` / `throw X(…)` names, as written with its qualifier and without type arguments. */
function typeText(n: Node | null | undefined): string | null {
  if (!n) return null;
  const head = n.type === "generic_type" ? n.namedChildren[0] : n;
  const text = head?.text.replace(/\s+/g, "");
  return text && /^[\w$.]+$/.test(text) ? text : null;
}

/** Names the method declares itself (parameters, locals, lambda and catch parameters, loop variables): a bare write to one is no field's. */
function declaredNames(body: Node, language: string): Set<string> {
  const out = new Set<string>();
  if (language === "kotlin") {
    for (const n of body.descendantsOfType(["variable_declaration", "parameter"])) {
      const id = n.namedChildren.find((c) => c.type === "simple_identifier");
      if (id) out.add(id.text);
    }
    return out;
  }
  for (const n of body.descendantsOfType(["variable_declarator", "formal_parameter", "spread_parameter", "catch_formal_parameter", "enhanced_for_statement", "resource", "type_pattern"])) {
    const id = n.childForFieldName("name") ?? n.namedChildren.find((c) => c.type === "identifier");
    if (id) out.add(id.text);
  }
  for (const n of body.descendantsOfType(["inferred_parameters", "lambda_expression"])) {
    for (const c of n.namedChildren) if (c.type === "identifier") out.add(c.text);
    const param = n.childForFieldName("parameters");
    if (param?.type === "identifier") out.add(param.text);
  }
  return out;
}

interface Target { receiver: string; member: string }

/** Java `this.x` / `a.x` / `this.a.x` / bare `x`. */
function javaTarget(left: Node | null | undefined, typed: ReadonlySet<string>, locals: ReadonlySet<string>): Target | null {
  if (!left) return null;
  if (left.type === "identifier") return locals.has(left.text) ? null : { receiver: "", member: left.text };
  if (left.type !== "field_access") return null;
  const member = left.childForFieldName("field");
  const obj = left.childForFieldName("object");
  if (member?.type !== "identifier" || !obj) return null;
  if (obj.type === "this") return { receiver: "this", member: member.text };
  if (obj.type === "identifier") return typed.has(obj.text) ? { receiver: obj.text, member: member.text } : null;
  if (obj.type === "field_access" && obj.childForFieldName("object")?.type === "this") {
    const field = obj.childForFieldName("field");
    return field?.type === "identifier" ? { receiver: `this.${field.text}`, member: member.text } : null;
  }
  return null;
}

/** Kotlin `this.x` / `a.x` / `this.a.x` / bare `x`, from a `directly_assignable_expression` or a `navigation_expression`. */
function kotlinTarget(left: Node | null | undefined, typed: ReadonlySet<string>, locals: ReadonlySet<string>): Target | null {
  if (!left) return null;
  if (left.type === "simple_identifier") return locals.has(left.text) ? null : { receiver: "", member: left.text };
  if (left.type !== "directly_assignable_expression" && left.type !== "navigation_expression") return null;
  const [head, ...rest] = left.namedChildren;
  const names = rest.filter((c) => c.type === "navigation_suffix").map((c) => c.namedChildren.find((x) => x.type === "simple_identifier")?.text);
  if (head?.type === "simple_identifier" && rest.length === 0) return locals.has(head.text) ? null : { receiver: "", member: head.text };
  if (!head || names.length !== rest.length || names.length === 0 || names.some((x) => !x)) return null;
  if (head.type === "this_expression") {
    if (names.length === 1) return { receiver: "this", member: names[0]! };
    return names.length === 2 ? { receiver: `this.${names[0]}`, member: names[1]! } : null;
  }
  if (head.type === "simple_identifier" && names.length === 1 && typed.has(head.text)) return { receiver: head.text, member: names[0]! };
  return null;
}

/**
 * What a Java/Kotlin method writes to fields and throws (`FunctionInfo.fieldWrites` / `throws`): assignments and
 * `++`/`--` on `this.x`, a bare field `x` the method does not declare, `this.field.x` and a typed parameter or local's
 * `p.x`; `throw new T(…)` / Kotlin `throw T(…)`; the `throws` clause and Kotlin `@Throws(T::class)` (`declared`).
 * A constructor states no writes — it initializes.
 */
export function jvmMemberEffects(
  node: Node,
  body: Node | null,
  language: string,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
): Effects | null {
  const typed = new Set<string>(localNames);
  for (const p of params) if (p.type) typed.add(p.name);
  const writes: NonNullable<Effects["fieldWrites"]> = [];
  const throws: NonNullable<Effects["throws"]> = [];
  const methodLine = node.startPosition.row + 1;
  const seenThrow = new Set<string>();
  const addThrow = (type: string | null, line: number, declared?: true): void => {
    if (!type || throws.length >= MAX_FACTS || seenThrow.has(`${type}|${declared ?? ""}|${line}`)) return;
    seenThrow.add(`${type}|${declared ?? ""}|${line}`);
    throws.push({ type, line, ...(declared ? { declared } : {}) });
  };
  if (language === "kotlin") {
    for (const a of node.descendantsOfType("annotation")) {
      if (a.parent?.parent?.id !== node.id) continue;
      if (!/^@?Throws\b/.test(a.text)) continue;
      for (const arg of a.descendantsOfType("value_argument")) {
        const written = arg.text.replace(/\s+/g, "");
        if (written.endsWith("::class") && /^[\w$.]+$/.test(written.slice(0, -7))) addThrow(written.slice(0, -7), methodLine, true);
      }
    }
  } else {
    const clause = node.namedChildren.find((c) => c.type === "throws");
    if (clause) for (const t of clause.namedChildren) addThrow(typeText(t), methodLine, true);
  }
  const initializer = node.type === "constructor_declaration" || node.type === "secondary_constructor";
  if (body) {
    const locals = declaredNames(body, language);
    for (const p of params) locals.add(p.name);
    const kotlin = language === "kotlin";
    const addWrite = (target: Target | null, at: Node): void => {
      if (initializer || !target || writes.length >= MAX_FACTS) return;
      const line = at.startPosition.row + 1;
      if (writes.some((w) => w.receiver === target.receiver && w.member === target.member && w.line === line)) return;
      writes.push({ member: target.member, receiver: target.receiver, line });
    };
    const visit = (n: Node, root: boolean): void => {
      if (!root && OWN_SCOPE_BREAKS.has(n.type)) return;
      switch (n.type) {
        case "assignment_expression":
          addWrite(javaTarget(n.childForFieldName("left"), typed, locals), n);
          break;
        case "update_expression":
          addWrite(javaTarget(n.namedChildren[0], typed, locals), n);
          break;
        case "assignment":
          addWrite(kotlinTarget(n.namedChildren[0], typed, locals), n);
          break;
        case "postfix_expression":
        case "prefix_expression":
          if (kotlin && (n.type === "postfix_expression" ? /(\+\+|--)$/ : /^(\+\+|--)/).test(n.text.trim())) addWrite(kotlinTarget(n.namedChildren[0], typed, locals), n);
          break;
        case "throw_statement": {
          const thrown = n.namedChildren.find((c) => c.type !== "comment");
          if (thrown?.type === "object_creation_expression") addThrow(typeText(thrown.childForFieldName("type") ?? thrown.namedChildren[0]), n.startPosition.row + 1);
          break;
        }
        case "jump_expression": {
          if (!kotlin || !n.text.startsWith("throw")) break;
          const call = n.namedChildren.find((c) => c.type === "call_expression");
          const callee = call?.namedChildren[0];
          if (callee?.type === "simple_identifier" || callee?.type === "navigation_expression") addThrow(typeText(callee), n.startPosition.row + 1);
          break;
        }
      }
      for (const c of n.namedChildren) visit(c, false);
    };
    visit(body, true);
  }
  if (writes.length === 0 && throws.length === 0) return null;
  return { ...(writes.length > 0 ? { fieldWrites: writes } : {}), ...(throws.length > 0 ? { throws } : {}) };
}
