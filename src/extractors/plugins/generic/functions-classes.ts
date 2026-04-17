import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { getNameFromNode, getVisibility } from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";

/**
 * Generic extractor for Go, Rust, Ruby, PHP using tree-sitter ASTs.
 * Each language has different AST node types; this maps them appropriately.
 */
export class GenericExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["go", "rust", "ruby", "php"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.walkFunctions(node, functions, node.tree.language as any);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.walkClasses(node, classes, node.tree.language as any);
  }

  private walkFunctions(node: Node, fns: FunctionInfo[], _lang: any): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      // Go: function_declaration, method_declaration
      if (child.type === "function_declaration" || child.type === "method_declaration") {
        fns.push(this.parseFn(child, "go"));
      }
      // Rust: function_item
      else if (child.type === "function_item") {
        fns.push(this.parseFn(child, "rust"));
      }
      // Ruby: method, singleton_method
      else if (child.type === "method" || child.type === "singleton_method") {
        fns.push(this.parseFn(child, "ruby"));
      }
      // PHP: function_definition, method_declaration
      else if (child.type === "function_definition" || child.type === "method_declaration") {
        fns.push(this.parseFn(child, "php"));
      }
      // Recurse into namespaces, modules, impl blocks
      else if (
        child.type === "namespace_definition" || child.type === "impl_item" ||
        child.type === "program" || child.type === "source_file" ||
        child.type === "module" || child.type === "class_declaration" ||
        child.type === "body"
      ) {
        this.walkFunctions(child, fns, _lang);
      }
    }
  }

  private walkClasses(node: Node, classes: ClassInfo[], _lang: any): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      // Go: type_declaration containing type_spec with struct/interface
      if (child.type === "type_declaration") {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j)!;
          if (spec.type === "type_spec") {
            const name = spec.childForFieldName("name")?.text ?? "anonymous";
            const typeNode = spec.childForFieldName("type");
            if (typeNode && (typeNode.type === "struct_type" || typeNode.type === "interface_type")) {
              classes.push({
                name,
                extends: null,
                implements: [],
                decorators: [],
                methods: [],
                properties: this.extractGoFields(typeNode),
                isExported: /^[A-Z]/.test(name),
                line: spec.startPosition.row + 1,
                endLine: spec.endPosition.row + 1,
              });
            }
          }
        }
      }
      // Rust: struct_item, enum_item, trait_item
      else if (child.type === "struct_item" || child.type === "enum_item" || child.type === "trait_item") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        classes.push({
          name,
          extends: null,
          implements: [],
          decorators: [],
          methods: [],
          properties: [],
          isExported: child.text.trimStart().startsWith("pub"),
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
      // Ruby: class, module
      else if (child.type === "class" || child.type === "module") {
        const name = child.childForFieldName("name")?.text ?? getNameFromNode(child) ?? "anonymous";
        const superclass = child.childForFieldName("superclass");
        classes.push({
          name,
          extends: superclass?.text ?? null,
          implements: [],
          decorators: [],
          methods: this.extractMethodsFromBody(child, "ruby", new Set(["method", "singleton_method"])),
          properties: [],
          isExported: true,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
      // PHP: class_declaration, interface_declaration, trait_declaration
      else if (child.type === "class_declaration" || child.type === "interface_declaration" || child.type === "trait_declaration") {
        const name = child.childForFieldName("name")?.text ?? "anonymous";
        const baseClause = child.childForFieldName("base_clause");
        classes.push({
          name,
          extends: baseClause?.text?.replace(/extends\s+/, "").split(",")[0]?.trim() ?? null,
          implements: [],
          decorators: [],
          methods: this.extractMethodsFromBody(child, "php", new Set(["method_declaration"])),
          properties: [],
          isExported: true,
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
      // Recurse
      else if (child.type === "program" || child.type === "source_file" || child.type === "namespace_definition") {
        this.walkClasses(child, classes, _lang);
      }
    }
  }

  private parseFn(node: Node, lang: string): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? getNameFromNode(node) ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (let i = 0; i < paramsNode.childCount; i++) {
        const p = paramsNode.child(i)!;
        if (p.type === "," || p.type === "(" || p.type === ")") continue;
        const pName = p.childForFieldName("name")?.text ?? p.text.split(/[\s:,=]/)[0];
        if (pName && pName !== "self" && pName !== "&self" && pName !== "&mut self") {
          params.push({
            name: pName,
            type: p.childForFieldName("type")?.text ?? null,
            defaultValue: p.childForFieldName("default_value")?.text ?? null,
          });
        }
      }
    }

    const returnType = node.childForFieldName("return_type")?.text
      ?? node.childForFieldName("result")?.text
      ?? null;

    const text = node.text;
    const isAsync = text.includes("async ") || text.includes("go ") || text.includes("goroutine");
    const isExported = lang === "go"
      ? /^[A-Z]/.test(name)
      : lang === "rust"
        ? text.trimStart().startsWith("pub")
        : lang === "php"
          ? !text.includes("private") && !text.includes("protected")
          : !name.startsWith("_");

    const body = node.childForFieldName("body") ?? node.childForFieldName("block");

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators: [],
      calls: extractCalls(body, lang as Language),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private extractGoFields(structNode: Node): PropertyInfo[] {
    const props: PropertyInfo[] = [];
    for (let i = 0; i < structNode.childCount; i++) {
      const child = structNode.child(i)!;
      if (child.type === "field_declaration_list") {
        for (let j = 0; j < child.childCount; j++) {
          const field = child.child(j)!;
          if (field.type === "field_declaration") {
            const name = field.childForFieldName("name")?.text ?? "";
            const type = field.childForFieldName("type")?.text ?? null;
            if (name) {
              props.push({
                name,
                type,
                visibility: /^[A-Z]/.test(name) ? "public" : "private",
                isStatic: false,
                isReadonly: false,
              });
            }
          }
        }
      }
    }
    return props;
  }

  private extractMethodsFromBody(
    classNode: Node,
    lang: string,
    methodTypes: Set<string>,
  ): FunctionInfo[] {
    const methods: FunctionInfo[] = [];
    const body = classNode.childForFieldName("body");
    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const child = body.child(i)!;
        if (methodTypes.has(child.type)) {
          methods.push(this.parseFn(child, lang));
        }
      }
    }
    return methods;
  }
}
