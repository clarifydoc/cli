import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";
import { jsDocThrows } from "./jsdoc.js";
import { EffectsCollector, MAX_FACTS, typedNames, visitOwnScope, type Effects } from "../shared/member-effects-kit.js";

/** Scopes whose `this` and locals are not the function's own. An arrow function keeps both, so it is walked. */
const OWN_SCOPE_BREAKS: ReadonlySet<string> = new Set([
  "function_expression", "function", "function_declaration", "generator_function", "generator_function_declaration",
  "method_definition", "class_body", "class", "class_declaration",
]);

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
  const typed = typedNames(params, localNames);
  const out = new EffectsCollector();
  const addWrite = (target: Node | null | undefined, at: Node): void => {
    if (options.initializer || target?.type !== "member_expression") return;
    const prop = target.childForFieldName("property");
    if (prop?.type !== "property_identifier") return;
    const receiver = receiverText(target.childForFieldName("object"), typed);
    if (receiver !== null) out.addWrite(receiver, prop.text, at.startPosition.row + 1);
  };
  visitOwnScope(body, (n) => OWN_SCOPE_BREAKS.has(n.type) || !!options.skip?.(n), (n) => {
    if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") addWrite(n.childForFieldName("left"), n);
    else if (n.type === "update_expression") addWrite(n.childForFieldName("argument"), n);
    else if (n.type === "throw_statement" && !out.throwsFull) {
      const thrown = n.namedChildren.find((c) => c.type !== "comment");
      const ctor = thrown?.type === "new_expression" ? thrown.childForFieldName("constructor") : null;
      if (ctor && (ctor.type === "identifier" || ctor.type === "member_expression") && /^[\w$.]+$/.test(ctor.text)) {
        out.addThrow(ctor.text, n.startPosition.row + 1);
      }
    }
  });
  return out.result();
}

/**
 * `effects` with the exception types a JSDoc `@throws {T}` declares, kept as `declared` beside what the body throws:
 * the tag is the function's stated contract (as a Java `throws` clause is), not a `throw` site, so it is stated even
 * when the body also throws the type, and a function that only delegates still lists what it promises.
 */
export function withJsDocThrows(effects: Effects | null, doc: string | null | undefined, line: number): Effects | null {
  const names = doc ? jsDocThrows(doc) : [];
  if (names.length === 0) return effects;
  const throws = [...(effects?.throws ?? [])];
  for (const type of names) if (throws.length < MAX_FACTS && !throws.some((t) => t.declared && t.type === type)) throws.push({ type, line, declared: true });
  return { ...(effects ?? {}), throws };
}
