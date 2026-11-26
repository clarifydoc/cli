import type { Node } from "web-tree-sitter";
import type { ParamInfo } from "../../../types/analysis.js";
import { EffectsCollector, typedNames, visitOwnScope, type Effects } from "../shared/member-effects-kit.js";

const NESTED: ReadonlySet<string> = new Set(["class_declaration", "anonymous_class", "function_definition", "interface_declaration", "trait_declaration", "enum_declaration"]);

/** `$name` → `name`; null for anything that is not a plain variable. */
function variableName(n: Node | null | undefined): string | null {
  if (n?.type !== "variable_name") return null;
  return n.text.replace(/^\$/, "");
}

/** The class a `new T(…)` names, as written (`\App\X` keeps its qualifier); `static`/`self`/`parent` and anything dynamic state nothing. */
function thrownType(n: Node | null | undefined): string | null {
  if (n?.type !== "object_creation_expression") return null;
  const head = n.namedChildren.find((c) => c.type === "name" || c.type === "qualified_name");
  const text = head?.text.replace(/\s+/g, "");
  if (!text || /^(?:static|self|parent)$/i.test(text)) return null;
  return /^\\?[\w\\]+$/.test(text) ? text : null;
}

/** The exception names a docblock's `@throws A|B` lines state, as written. */
function documentedThrows(docblock: string | null): string[] {
  if (!docblock) return [];
  const out: string[] = [];
  for (const m of docblock.matchAll(/@throws\s+([^\s*]+)/g)) {
    for (const part of m[1]!.split("|")) if (/^\\?[A-Za-z_][\w\\]*$/.test(part)) out.push(part);
  }
  return out;
}

/**
 * What a PHP method writes to properties and throws (`FunctionInfo.fieldWrites` / `throws`): `$this->x = …`,
 * `$this->x += …`, `$this->x++`, `self::$x`/`static::$x` writes (a static property of the own class), `$this->a->x = …`
 * and `$p->x = …` on a typed parameter or local; `throw new T(…)` (statement or expression) and the docblock's
 * `@throws T` as `declared`. A dynamic property (`$this->$name`) and a thrown variable state nothing; a constructor
 * states no writes — it initializes. A read (`fieldReads`) is `$this->x`, `$this->a->x` or a typed variable's
 * `$p->x` that is no plain `=` target (`+=` reads, a method call is no read). Closures keep `$this` and are walked; a nested class or function is not.
 * A class is named through the writing file's `use`/namespace (`class-evidence.ts`, the symbol linker's own rule);
 * `self::$x` / `static::$x` read as `this`. A type written through a namespace path is stated as
 * `ParamInfo.typePath` / `PropertyInfo.typePath` beside the bare `type`, so a namesake class of the writer's own
 * namespace never answers for `\App\Models\Club $c`. A static property written from outside its class
 * (`Club::$count = 0`) is a write with `fieldWrites[].class` set to the class as written, bound like a thrown type.
 */
export function phpMemberEffects(
  body: Node | null,
  params: readonly ParamInfo[],
  localNames: Iterable<string>,
  docblock: string | null,
  methodName: string | null,
  line: number,
): Effects | null {
  const out = new EffectsCollector();
  for (const type of documentedThrows(docblock)) out.addThrow(type, line, true);
  if (!body) return out.result();
  const typed = typedNames(params, localNames);
  const initializer = methodName?.toLowerCase() === "__construct";
  const addWrite = (left: Node | null | undefined, at: Node): void => {
    // An element write (`$this->items[] = $x`, `$this->map['k'] = $v`) changes the property it indexes.
    while (left?.type === "subscript_expression") left = left.namedChildren[0];
    if (initializer || !left) return;
    const row = at.startPosition.row + 1;
    if (left.type === "scoped_property_access_expression") {
      const scope = left.childForFieldName("scope") ?? left.namedChildren[0];
      const name = variableName(left.childForFieldName("name") ?? left.namedChildren[left.namedChildren.length - 1]);
      if (scope?.type === "relative_scope" && /^(?:self|static)$/.test(scope.text) && name) out.addWrite("this", name, row);
      else if ((scope?.type === "name" || scope?.type === "qualified_name") && name) {
        // `Club::$count = 0` from outside the class: the class as written, bound by core through the file's evidence.
        const written = scope.text.replace(/\s+/g, "");
        if (/^\\?[A-Za-z_][\w\\]*$/.test(written)) out.addWrite("", name, row, undefined, undefined, written);
      }
      return;
    }
    if (left.type !== "member_access_expression") return;
    const member = left.childForFieldName("name");
    const obj = left.childForFieldName("object");
    if (member?.type !== "name" || !obj) return;
    const own = variableName(obj);
    if (own === "this") out.addWrite("this", member.text, row);
    else if (own && typed.has(own)) out.addWrite(own, member.text, row);
    else if (obj.type === "member_access_expression" && variableName(obj.childForFieldName("object")) === "this") {
      const field = obj.childForFieldName("name");
      if (field?.type === "name") out.addWrite(`this.${field.text}`, member.text, row);
    }
  };
  /** A read: `$this->x`, `$this->a->x` or a typed variable's `$p->x` that is no plain `=` target (`->x()` is a `member_call_expression`, never this node; `+=` reads). */
  const addRead = (n: Node): void => {
    const member = n.childForFieldName("name");
    const obj = n.childForFieldName("object");
    if (member?.type !== "name" || !obj) return;
    let top: Node = n;
    while (top.parent?.type === "subscript_expression" && top.parent.namedChildren[0]?.id === top.id) top = top.parent;
    const parent = top.parent;
    if (parent?.type === "assignment_expression" && parent.childForFieldName("left")?.id === top.id && parent.children.some((c) => c.type === "=")) return;
    const row = n.startPosition.row + 1;
    const own = variableName(obj);
    if (own === "this") out.addRead("this", member.text, row);
    else if (own && typed.has(own)) out.addRead(own, member.text, row);
    else if (obj.type === "member_access_expression" && variableName(obj.childForFieldName("object")) === "this") {
      const field = obj.childForFieldName("name");
      if (field?.type === "name") out.addRead(`this.${field.text}`, member.text, row);
    }
  };
  visitOwnScope(body, (n) => NESTED.has(n.type), (n) => {
    switch (n.type) {
      case "member_access_expression":
        addRead(n);
        break;
      case "assignment_expression":
      case "augmented_assignment_expression":
        addWrite(n.childForFieldName("left"), n);
        break;
      case "update_expression":
        addWrite(n.namedChildren[0], n);
        break;
      case "throw_expression": {
        if (out.throwsFull) break;
        const type = thrownType(n.namedChildren.find((c) => c.type !== "comment"));
        if (type) out.addThrow(type, n.startPosition.row + 1);
        break;
      }
    }
  });
  return out.result();
}
