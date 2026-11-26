import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";
import { dottedTarget, EffectsCollector, typedNames, visitOwnScope, type AccessShape, type Effects } from "../shared/member-effects-kit.js";

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

const ACCESS: AccessShape = { access: "member_access_expression", member: "name", object: "expression", thisTypes: new Set(["this_expression", "this"]) };
const NESTED_TYPES: ReadonlySet<string> = new Set(["class_declaration", "record_declaration", "struct_declaration"]);

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
 * nothing. A property read (`fieldReads`) is `this.x`, `this.field.x` or a typed name's `p.x` that is no callee and no plain `=` target. A constructor states no writes — it initializes. Local functions and lambdas keep `this` and are walked.
 *
 * Core's `member-effects` pass resolves types to project classes by declared types only and only within the
 * language family; C# types found only
 * in the writer's directory (`typesSpanFiles` without `typesBeyondDirectory`) are looked up as written; a
 * qualified name binds by its last segment only through a qualifier the project backs (a namespace the class is
 * declared in — `ClassInfo.namespace` — or a name the writing file imports, `using Err = …`).
 */
export function csharpMemberEffects(
  node: Node,
  body: Node | null,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
): Effects | null {
  if (!body) return null;
  const typed = typedNames(params, localNames);
  // Only a bare-identifier target asks for the declared names, so a method with none never walks for them.
  let declared: Set<string> | null = null;
  const locals = (): Set<string> => {
    if (!declared) {
      declared = declaredNames(body);
      for (const p of params) declared.add(p.name);
    }
    return declared;
  };
  const initializer = node.type === "constructor_declaration";
  const out = new EffectsCollector();
  const addWrite = (left: Node | null | undefined, at: Node): void => {
    if (initializer) return;
    const t = dottedTarget(left, ACCESS, typed, locals);
    if (t) out.addWrite(t.receiver, t.member, at.startPosition.row + 1);
  };
  /** A read: `this.x`, `this.field.x` or a typed name's `p.x` that is no callee and no plain `=` target (bare names state nothing: a local and a member look alike). */
  const addRead = (n: Node): void => {
    const parent = n.parent;
    if (parent?.type === "assignment_expression" && parent.childForFieldName("left")?.id === n.id && parent.childForFieldName("operator")?.text === "=") return;
    if (parent?.type === "invocation_expression" && parent.childForFieldName("function")?.id === n.id) return;
    const t = dottedTarget(n, ACCESS, typed, locals);
    if (t && t.receiver !== "") out.addRead(t.receiver, t.member, n.startPosition.row + 1);
  };
  visitOwnScope(body, (n) => NESTED_TYPES.has(n.type), (n) => {
    switch (n.type) {
      case "member_access_expression":
        addRead(n);
        break;
      case "assignment_expression":
        addWrite(n.childForFieldName("left"), n);
        break;
      case "postfix_unary_expression":
      case "prefix_unary_expression":
        if (n.children.some((c) => c.type === "++" || c.type === "--")) addWrite(n.namedChildren[0], n);
        break;
      case "throw_statement":
      case "throw_expression": {
        const type = thrownType(n.namedChildren.find((c) => c.type !== "comment"));
        if (type) out.addThrow(type, n.startPosition.row + 1);
        break;
      }
    }
  });
  return out.result();
}
