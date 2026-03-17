import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "./base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "./base.js";

export class JavaScriptExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractJsFunctions(node, functions, false);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractJsClasses(node, classes);
  }

  private extractJsFunctions(
    node: Node,
    functions: FunctionInfo[],
    isExported: boolean,
  ): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "export_statement") {
        this.extractJsFunctions(child, functions, true);
        continue;
      }

      if (
        child.type === "function_declaration" ||
        child.type === "generator_function_declaration"
      ) {
        functions.push(this.parseJsFunction(child, isExported));
      } else if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (let j = 0; j < child.childCount; j++) {
          const decl = child.child(j)!;
          if (decl.type === "variable_declarator") {
            const name = decl.childForFieldName("name")?.text;
            const value = decl.childForFieldName("value");
            if (
              name &&
              value &&
              (value.type === "arrow_function" ||
                value.type === "function_expression")
            ) {
              functions.push(this.parseJsArrowOrExpr(name, value, isExported));
            }
          }
        }
      }
    }
  }

  private parseJsFunction(node: Node, isExported: boolean): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const params = this.extractJsParams(node.childForFieldName("parameters"));
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = node.text.startsWith("async ");
    const decorators = this.extractDecorators(node);

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private parseJsArrowOrExpr(
    name: string,
    node: Node,
    isExported: boolean,
  ): FunctionInfo {
    const params = this.extractJsParams(node.childForFieldName("parameters"));
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = node.text.startsWith("async ");

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators: [],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private extractJsParams(paramsNode: Node | null): ParamInfo[] {
    if (!paramsNode) return [];
    const params: ParamInfo[] = [];

    for (let i = 0; i < paramsNode.childCount; i++) {
      const child = paramsNode.child(i)!;
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "identifier" ||
        child.type === "rest_pattern"
      ) {
        const name =
          child.childForFieldName("pattern")?.text ??
          child.childForFieldName("name")?.text ??
          child.text;
        const typeNode = child.childForFieldName("type");
        const defaultNode = child.childForFieldName("value");

        params.push({
          name,
          type: typeNode?.text?.replace(/^:\s*/, "") ?? null,
          defaultValue: defaultNode?.text ?? null,
        });
      }
    }
    return params;
  }

  private extractJsClasses(node: Node, classes: ClassInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      let isExported = false;

      if (child.type === "export_statement") {
        isExported = true;
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j)!;
          if (inner.type === "class_declaration") {
            classes.push(this.parseJsClass(inner, true));
          }
        }
        continue;
      }

      if (child.type === "class_declaration") {
        classes.push(this.parseJsClass(child, isExported));
      }
    }
  }

  private parseJsClass(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const heritage = node.childForFieldName("heritage");
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    if (heritage) {
      for (let i = 0; i < heritage.childCount; i++) {
        const clause = heritage.child(i)!;
        if (clause.type === "extends_clause") {
          extendsName = clause.child(1)?.text ?? null;
        }
        if (clause.type === "implements_clause") {
          for (let j = 1; j < clause.childCount; j++) {
            const impl = clause.child(j)!;
            if (impl.type !== ",") implementsList.push(impl.text);
          }
        }
      }
    }

    const decorators = this.extractDecorators(node);
    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i)!;
        if (
          member.type === "method_definition" ||
          member.type === "public_field_definition"
        ) {
          if (member.type === "method_definition") {
            const methodName =
              member.childForFieldName("name")?.text ?? "anonymous";
            const params = this.extractJsParams(
              member.childForFieldName("parameters"),
            );
            const returnType = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
            const isAsync = member.text.startsWith("async ");
            methods.push({
              name: methodName,
              params,
              returnType,
              isAsync,
              isExported: false,
              decorators: this.extractDecorators(member),
              line: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
            });
          } else {
            const propName =
              member.childForFieldName("name")?.text ?? "unknown";
            properties.push({
              name: propName,
              type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
              visibility: this.getVisibility(member),
              isStatic: member.text.includes("static "),
              isReadonly: member.text.includes("readonly "),
            });
          }
        }
      }
    }

    return {
      name,
      extends: extendsName,
      implements: implementsList,
      decorators,
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private extractDecorators(node: Node): string[] {
    const decorators: string[] = [];
    const parent = node.parent;
    if (!parent) return decorators;

    for (let i = 0; i < parent.childCount; i++) {
      const sibling = parent.child(i)!;
      if (sibling === node) break;
      if (sibling.type === "decorator") {
        const expr = sibling.child(1);
        decorators.push(expr?.text ?? sibling.text.replace(/^@/, ""));
      }
    }
    return decorators;
  }

  private getVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    const text = node.text;
    if (text.includes("private ")) return "private";
    if (text.includes("protected ")) return "protected";
    if (text.includes("public ")) return "public";
    return null;
  }
}
