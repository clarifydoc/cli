import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, Language, PropertyInfo } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { isFunctionBinding } from "./syntax.js";

/**
 * The name the file's own module is extracted under; the plugin's
 * `postExtract` renames it to the module the file is (`db.ml` → `Db`).
 */
export const FILE_MODULE = "@file";

/**
 * OCaml modules, types and functions. A file IS a module (`db.ml` is `Db`):
 * its function `let`s are that module's methods, as are a nested
 * `module X = struct … end`'s (a functor's included) for module `X`. A
 * `module type S = sig … end` is an interface. A record type is a class of
 * its fields, a variant an enum, an object `class` a class of its methods.
 * Interface files (`.mli`) declare and define nothing here.
 */
export class OCamlExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["ocaml"];

  protected collectFunctions(_node: Node, _functions: FunctionInfo[]): void {}

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    if (node.type !== "compilation_unit" || node.namedChildren.some((c) => c.type === "value_specification")) return;
    classes.push(moduleClass(FILE_MODULE, node, node));
    const visit = (scope: Node) => {
      for (const child of scope.namedChildren) {
        if (child.type === "module_definition") {
          for (const binding of child.namedChildren.filter((c) => c.type === "module_binding")) {
            const name = binding.namedChildren.find((c) => c.type === "module_name")?.text;
            const body = binding.childForFieldName("body");
            if (name && body?.type === "structure") {
              classes.push(moduleClass(name, body, binding));
              visit(body);
            }
          }
        } else if (child.type === "module_type_definition") {
          const name = child.namedChildren.find((c) => c.type === "module_type_name")?.text;
          const sig = child.childForFieldName("body");
          if (name && sig) {
            const cls = blank(name, child);
            cls.kind = "interface";
            cls.methods = sig.namedChildren.filter((c) => c.type === "value_specification").map((v) => ({
              name: v.namedChildren.find((c) => c.type === "value_name")?.text ?? "",
              params: [], returnType: v.childForFieldName("type")?.text ?? null, isAsync: false, isExported: true, decorators: [], calls: [],
              line: v.startPosition.row + 1, endLine: v.endPosition.row + 1,
            }));
            classes.push(cls);
          }
        } else if (child.type === "type_definition") {
          for (const tb of child.namedChildren.filter((c) => c.type === "type_binding")) {
            const name = tb.childForFieldName("name")?.text;
            const body = tb.childForFieldName("body");
            if (!name || !body) continue;
            if (body.type === "record_declaration") {
              const cls = blank(name, tb);
              cls.properties = body.namedChildren.filter((f) => f.type === "field_declaration").map(field);
              classes.push(cls);
            } else if (body.type === "variant_declaration") {
              const cls = blank(name, tb);
              cls.kind = "enum";
              classes.push(cls);
            }
          }
        } else if (child.type === "class_definition") {
          for (const cb of child.namedChildren.filter((c) => c.type === "class_binding")) {
            const name = cb.namedChildren.find((c) => c.type === "class_name")?.text;
            if (!name) continue;
            const cls = blank(name, cb);
            cls.methods = cb.descendantsOfType("method_definition").map((m) => ({
              name: m.namedChildren.find((c) => c.type === "method_name")?.text ?? "",
              params: params(m), returnType: null, isAsync: false, isExported: true, decorators: [],
              calls: extractCalls(m.childForFieldName("body"), "ocaml"),
              line: m.startPosition.row + 1, endLine: m.endPosition.row + 1,
            }));
            cls.properties = cb.descendantsOfType("instance_variable_definition").map((v) => prop(v.namedChildren[0]?.text ?? "", null));
            classes.push(cls);
          }
        }
      }
    };
    visit(node);
  }
}

function blank(name: string, span: Node): ClassInfo {
  return { name, extends: null, implements: [], decorators: [], methods: [], properties: [], isExported: true, line: span.startPosition.row + 1, endLine: span.endPosition.row + 1 };
}

/** A module: its function `let`s (each `and` of a `let rec` too) are methods. */
function moduleClass(name: string, body: Node, span: Node): ClassInfo {
  const cls = blank(name, span);
  for (const def of body.namedChildren.filter((c) => c.type === "value_definition")) {
    for (const binding of def.namedChildren.filter(isFunctionBinding)) cls.methods.push(fn(binding));
  }
  return cls;
}

function prop(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: true };
}

function field(node: Node): PropertyInfo {
  return prop(node.namedChildren.find((c) => c.type === "field_name")?.text ?? "", node.childForFieldName("type")?.text ?? null);
}

/** `x`, `(repo : Repo.t)`, `~id`, `?(limit = 10)`; `()` is no parameter. */
function params(node: Node): FunctionInfo["params"] {
  const out: FunctionInfo["params"] = [];
  const body = node.childForFieldName("body");
  const list = node.namedChildren.filter((c) => c.type === "parameter");
  if (list.length === 0 && body?.type === "fun_expression") list.push(...body.namedChildren.filter((c) => c.type === "parameter"));
  for (const p of list) {
    const pattern = p.childForFieldName("pattern");
    if (!pattern || pattern.type === "unit") continue;
    const typed = pattern.type === "typed_pattern" ? pattern : pattern.type === "parenthesized_pattern" ? pattern.namedChildren.find((c) => c.type === "typed_pattern") : null;
    const name = (typed?.childForFieldName("pattern") ?? pattern).text.replace(/^[~?]/, "");
    if (!/^[a-z_][\w']*$/.test(name)) continue;
    out.push({ name, type: typed?.childForFieldName("type")?.text ?? null, defaultValue: p.childForFieldName("default")?.text ?? null });
  }
  return out;
}

function fn(binding: Node): FunctionInfo {
  const body = binding.childForFieldName("body");
  return {
    name: binding.childForFieldName("pattern")!.text,
    params: params(binding),
    returnType: binding.childForFieldName("type")?.text ?? null,
    isAsync: false,
    isExported: true,
    decorators: [],
    calls: extractCalls(body, "ocaml"),
    line: binding.startPosition.row + 1,
    endLine: binding.endPosition.row + 1,
  };
}
