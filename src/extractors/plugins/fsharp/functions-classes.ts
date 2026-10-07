import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { attributesOf, bindingName, bodyOf, isFunctionDefn, MODULE_NODES, patternParams } from "./syntax.js";

/**
 * F# functions and types.
 *
 *  - Functions: the module-level `let`s of the file, its namespaces and its
 *    nested modules — `let f x = …`, and a value that computes something
 *    (`let webApp = choose […]`, `let handler = fun next ctx -> …`); a constant
 *    (`let port = 8080`) is no function. Calls in local `let`s belong to the
 *    enclosing function.
 *  - Types: records (fields become properties), unions, and classes — the
 *    primary constructor (`type Svc(repo: IRepo)`) is the class's constructor
 *    and its parameters are the injection points; `member`s are methods;
 *    `inherit Base(…)` is the base class; `interface IX with` lists an
 *    implemented interface. A type with nothing but `abstract` members is an
 *    interface.
 */
export class FSharpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["fsharp"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.namedChildren) {
      if (MODULE_NODES.has(child.type)) {
        this.collectFunctions(child, functions);
        continue;
      }
      if (child.type !== "declaration_expression") continue;
      const defn = child.namedChildren.find((c) => c.type === "function_or_value_defn");
      if (!defn) continue;
      const fn = this.binding(defn, attributesOf(child.namedChildren.find((c) => c.type === "attributes") ?? null));
      if (fn) functions.push(fn);
    }
  }

  private binding(defn: Node, decorators: string[]): FunctionInfo | null {
    const name = bindingName(defn);
    const left = defn.namedChildren[0];
    const body = bodyOf(defn);
    if (!name || !left || !body || body.id === left.id) return null;
    if (!isFunctionDefn(defn)) return null;
    const isFunction = left.type === "function_declaration_left";
    const returnType = defn.namedChildren.find((c, i) => i > 0 && c.id !== body.id && /_type$/.test(c.type))?.text ?? null;
    const params = isFunction
      ? patternParams(left.namedChildren.filter((c) => c.type === "argument_patterns"))
      : body.type === "fun_expression"
        ? patternParams(body.namedChildren.filter((c) => c.type === "argument_patterns"))
        : [];
    return {
      name,
      params,
      returnType,
      isAsync: /^(?:task|async)$/.test(body.namedChildren[0]?.text ?? ""),
      isExported: !/^\s*let\s+(?:inline\s+)?private\b/.test(defn.parent?.text.slice(0, 40) ?? ""),
      decorators,
      calls: extractCalls(body, "fsharp"),
      line: defn.startPosition.row + 1,
      endLine: defn.endPosition.row + 1,
    };
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.namedChildren) {
      if (MODULE_NODES.has(child.type)) {
        this.collectClasses(child, classes);
        continue;
      }
      if (child.type !== "type_definition") continue;
      for (const defn of child.namedChildren) {
        const cls = this.typeDefn(defn, attributesOf(child.namedChildren.find((c) => c.type === "attributes") ?? null));
        if (cls) classes.push(cls);
      }
    }
  }

  private typeDefn(defn: Node, decorators: string[]): ClassInfo | null {
    const name = defn.namedChildren.find((c) => c.type === "type_name")?.descendantsOfType("identifier")[0]?.text;
    if (!name) return null;
    const cls: ClassInfo = {
      name,
      extends: null,
      implements: [],
      decorators,
      methods: [],
      properties: [],
      isExported: true,
      line: defn.startPosition.row + 1,
      endLine: defn.endPosition.row + 1,
    };
    if (defn.type === "record_type_defn") {
      for (const field of defn.descendantsOfType("record_field")) {
        const fieldName = field.namedChildren.find((c) => c.type === "identifier")?.text;
        const type = field.namedChildren.find((c) => /_type$/.test(c.type))?.text ?? null;
        if (fieldName) cls.properties.push(prop(fieldName, type));
      }
      return cls;
    }
    if (defn.type === "union_type_defn") return cls;
    if (defn.type !== "anon_type_defn") return null;

    const ctorArgs = defn.namedChildren.find((c) => c.type === "primary_constr_args");
    if (ctorArgs) {
      cls.methods.push({
        name, params: patternParams([ctorArgs]), returnType: null, isAsync: false, isExported: true, decorators: [], calls: [],
        line: ctorArgs.startPosition.row + 1, endLine: ctorArgs.endPosition.row + 1,
      });
    }
    const inherits = defn.namedChildren.find((c) => c.type === "class_inherits_decl");
    if (inherits) cls.extends = inherits.namedChildren.find((c) => /_type$/.test(c.type))?.text.replace(/<.*$/, "") ?? null;

    let abstractOnly = true;
    for (const elements of defn.namedChildren.filter((c) => c.type === "type_extension_elements")) {
      for (const el of elements.namedChildren) {
        if (el.type === "interface_implementation") {
          const iface = el.namedChildren.find((c) => /_type$/.test(c.type))?.text.replace(/<.*$/, "");
          if (iface && !cls.implements.includes(iface)) cls.implements.push(iface);
          for (const m of el.namedChildren.filter((c) => c.type === "member_defn")) this.member(m, cls);
          abstractOnly = false;
          continue;
        }
        if (el.type !== "member_defn") continue;
        if (!el.namedChildren.some((c) => c.type === "member_signature")) abstractOnly = false;
        this.member(el, cls);
      }
    }
    if (abstractOnly && !ctorArgs && cls.methods.length > 0) cls.kind = "interface";
    return cls;
  }

  /** One `member` / `abstract` / `member val` of a class. */
  private member(member: Node, cls: ClassInfo): void {
    const sig = member.namedChildren.find((c) => c.type === "member_signature");
    if (sig) {
      const name = sig.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name) cls.methods.push(method(name, [], null, member, []));
      return;
    }
    const def = member.namedChildren.find((c) => c.type === "method_or_prop_defn");
    if (!def) {
      // `member val Name = "x" with get, set` — an auto-property.
      const name = member.namedChildren.find((c) => c.type === "property_or_ident")?.descendantsOfType("identifier").pop()?.text;
      if (name) cls.properties.push(prop(name, null));
      return;
    }
    const nameNode = def.namedChildren.find((c) => c.type === "property_or_ident");
    const name = nameNode?.descendantsOfType("identifier").pop()?.text;
    if (!name) return;
    const body = bodyOf(def);
    const patterns = def.namedChildren.filter((c) => c.id !== nameNode!.id && c.id !== body?.id);
    cls.methods.push(method(name, patternParams(patterns), body, member, []));
  }
}

function method(name: string, params: FunctionInfo["params"], body: Node | null, node: Node, decorators: string[]): FunctionInfo {
  return {
    name, params, returnType: null, isAsync: false,
    isExported: !/^\s*(?:member\s+)?private\b/.test(node.text.slice(0, 30)),
    decorators, calls: extractCalls(body, "fsharp"),
    line: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
  };
}

function prop(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: true };
}
