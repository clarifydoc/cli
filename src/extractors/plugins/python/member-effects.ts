import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";
import { EffectsCollector, typedNames, visitOwnScope, type Effects } from "../shared/member-effects-kit.js";

/** A name a function binds itself: assignment targets, loop and `with`/`except … as` names, walrus, comprehension variables, lambda parameters, nested `def` names. */
function boundNames(body: Node): Set<string> {
  const out = new Set<string>();
  const add = (n: Node | null | undefined): void => {
    if (!n) return;
    if (n.type === "identifier") out.add(n.text);
    else if (n.type === "pattern_list" || n.type === "tuple_pattern" || n.type === "list_pattern" || n.type === "list_splat_pattern") for (const c of n.namedChildren) add(c);
  };
  for (const n of body.descendantsOfType(["assignment", "for_statement", "for_in_clause", "named_expression"])) add(n.childForFieldName("left") ?? n.childForFieldName("name"));
  for (const n of body.descendantsOfType(["as_pattern", "with_item"])) add(n.childForFieldName("alias") ?? n.namedChildren.find((c) => c.type === "as_pattern_target"));
  for (const n of body.descendantsOfType("as_pattern_target")) add(n.namedChildren[0]);
  for (const n of body.descendantsOfType("lambda_parameters")) for (const c of n.namedChildren) add(c);
  return out;
}

/** The thrown class an expression names (`XError(…)`, `pkg.XError`); a lowercase leaf is a variable or a call result and states nothing. */
function thrownClass(n: Node | null | undefined, locals: () => ReadonlySet<string>): string | null {
  const head = n?.type === "call" ? n.childForFieldName("function") : n;
  if (!head || (head.type !== "identifier" && head.type !== "attribute")) return null;
  const text = head.text.replace(/\s+/g, "");
  if (!/^[A-Za-z_][\w.]*$/.test(text)) return null;
  const leaf = text.slice(text.lastIndexOf(".") + 1);
  if (!/^[A-Z]/.test(leaf) || (head.type === "identifier" && locals().has(text))) return null;
  return text;
}

/**
 * What a Python function writes to attributes and raises (`FunctionInfo.fieldWrites` / `throws`): `self.x = …`,
 * `self.x += …`, `self.a.x = …` and `p.x = …` on a typed parameter or local (`self`/`cls` is the receiver `this`);
 * `raise XError(…)` and `raise XError` (a class named by a capitalized leaf; a variable or a call result states
 * nothing, nor does a bare `raise`). `__init__` states its `self.x` writes as `init` (declarations, never writers). Nested functions and lambdas keep
 * `self` and are walked; a nested class is not. A qualified name (`requests.HTTPError`) binds by its last segment only
 * through a qualifier the project backs (a Python module path). A read (`fieldReads`) is `self.x`, `self.a.x` or a
 * typed name's `p.x` that is no callee and no `=`, `for` or `del` target; `+=` reads.
 */
export function pythonMemberEffects(
  node: Node,
  body: Node | null,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
  selfName: string | null,
): Effects | null {
  if (!body) return null;
  const typed = typedNames(params, localNames, selfName);
  // Only `raise <Name>` asks for the bound names (a bound lowercase-or-capitalized name is a variable).
  let bound: Set<string> | null = null;
  const locals = (): ReadonlySet<string> => {
    if (!bound) {
      bound = boundNames(body);
      for (const p of params) bound.add(p.name);
    }
    return bound;
  };
  const initializer = node.childForFieldName("name")?.text === "__init__";
  const out = new EffectsCollector();
  const receiverOf = (n: Node | null | undefined): string | null => {
    if (!n) return null;
    if (n.type === "identifier") return selfName && n.text === selfName ? "this" : typed.has(n.text) ? n.text : null;
    if (n.type === "attribute" && selfName && n.childForFieldName("object")?.type === "identifier" && n.childForFieldName("object")!.text === selfName) {
      return `this.${n.childForFieldName("attribute")!.text}`;
    }
    return null;
  };
  const addWrite = (target: Node | null | undefined, at: Node): void => {
    if (!target) return;
    if (target.type === "pattern_list" || target.type === "tuple_pattern" || target.type === "list_pattern") {
      for (const c of target.namedChildren) addWrite(c, at);
      return;
    }
    if (target.type !== "attribute") return;
    const member = target.childForFieldName("attribute");
    const receiver = receiverOf(target.childForFieldName("object"));
    if (!member || receiver === null) return;
    const line = at.startPosition.row + 1;
    // An initializer's write declares the attribute (core never lists it as a writer); only `self` ones declare.
    if (initializer && receiver.startsWith("this")) {
      if (receiver === "this") out.addWrite(receiver, member.text, line, true);
      return;
    }
    out.addWrite(receiver, member.text, line);
  };
  /** A read: `self.x`, `self.a.x` or a typed name's `p.x` that is no callee, no `=`/`for`/`del` target (`+=` reads). */
  const addRead = (n: Node): void => {
    const object = n.childForFieldName("object");
    const member = n.childForFieldName("attribute");
    if (!member || !object || (object.type !== "identifier" && object.type !== "attribute")) return;
    let top: Node = n;
    while (top.parent && ["pattern_list", "tuple_pattern", "list_pattern", "list_splat_pattern"].includes(top.parent.type)) top = top.parent;
    const parent = top.parent;
    if (parent?.type === "call" && parent.childForFieldName("function")?.id === n.id) return;
    if ((parent?.type === "assignment" || parent?.type === "for_statement" || parent?.type === "for_in_clause") && parent.childForFieldName("left")?.id === top.id) return;
    if (parent?.type === "delete_statement") return;
    const receiver = receiverOf(object);
    if (receiver !== null) out.addRead(receiver, member.text, n.startPosition.row + 1);
  };
  visitOwnScope(body, (n) => n.type === "class_definition", (n) => {
    if (n.type === "attribute") addRead(n);
    else if (n.type === "assignment" || n.type === "augmented_assignment") addWrite(n.childForFieldName("left"), n);
    else if (n.type === "raise_statement" && !out.throwsFull) {
      const type = thrownClass(n.namedChildren[0], locals);
      if (type) out.addThrow(type, n.startPosition.row + 1);
    }
  });
  return out.result();
}
