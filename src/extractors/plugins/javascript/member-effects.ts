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
 *
 * States per function what it assigns (`FunctionInfo.fieldWrites`: `member`, `receiver` as written — `this`,
 * `this.<field>`, a parameter or local that carries a declared type, "" for a bare field — and line; never from a
 * constructor, never from an untyped receiver, nested non-arrow functions and local classes left out) and what it
 * throws (`FunctionInfo.throws`: the type as written with its qualifier, the `throw new T` site, `declared` for a
 * JSDoc `@throws {T}`; a rethrown variable states nothing). A name imported as a namespace
 * (`import * as errors from "./x"`) backs a qualified type. Core resolves within the writer's language family by
 * declared types only, so a TypeScript `throw new Error` never meets a Go `Error` struct.
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
  /** `this.x` / `a.x` / `this.a.x` read as a value: not a callee, not the target of a plain `=` (a `+=` and `++` read it too). */
  const addRead = (n: Node): void => {
    const prop = n.childForFieldName("property");
    if (prop?.type !== "property_identifier") return;
    const parent = n.parent;
    if (parent?.type === "call_expression" && parent.childForFieldName("function")?.id === n.id) return;
    if (parent?.type === "assignment_expression" && parent.childForFieldName("left")?.id === n.id) return;
    const receiver = receiverText(n.childForFieldName("object"), typed);
    if (receiver !== null) out.addRead(receiver, prop.text, n.startPosition.row + 1);
  };
  visitOwnScope(body, (n) => OWN_SCOPE_BREAKS.has(n.type) || !!options.skip?.(n), (n) => {
    if (n.type === "member_expression") addRead(n);
    else if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression") addWrite(n.childForFieldName("left"), n);
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
