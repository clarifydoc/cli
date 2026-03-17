import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "./base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "./base.js";

export class CSharpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["csharp"];

  protected collectFunctions(_node: Node, _functions: FunctionInfo[]): void {
    // C# functions are inside classes, handled in collectClasses
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractCsharpClasses(node, classes);
  }

  private extractCsharpClasses(node: Node, classes: ClassInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body");
        if (body) this.extractCsharpClasses(body, classes);
        this.extractCsharpClasses(child, classes);
      } else if (child.type === "class_declaration") {
        classes.push(this.parseCsharpClass(child));
      }
    }
  }

  private parseCsharpClass(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const bases = node.childForFieldName("bases");
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    if (bases) {
      for (let i = 0; i < bases.childCount; i++) {
        const base = bases.child(i)!;
        if (base.type !== "," && base.type !== ":") {
          if (!extendsName) {
            extendsName = base.text;
          } else {
            implementsList.push(base.text);
          }
        }
      }
    }

    const decorators: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "attribute_list") {
        for (let j = 0; j < child.childCount; j++) {
          const attr = child.child(j)!;
          if (attr.type === "attribute") {
            decorators.push(attr.childForFieldName("name")?.text ?? attr.text);
          }
        }
      }
    }

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i)!;
        if (member.type === "method_declaration") {
          methods.push(this.parseCsharpMethod(member));
        } else if (member.type === "property_declaration") {
          const propName =
            member.childForFieldName("name")?.text ?? "unknown";
          properties.push({
            name: propName,
            type: member.childForFieldName("type")?.text ?? null,
            visibility: this.getCsharpVisibility(member),
            isStatic: this.hasModifier(member, "static"),
            isReadonly: this.hasModifier(member, "readonly"),
          });
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
      isExported: true,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private parseCsharpMethod(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (let i = 0; i < paramsNode.childCount; i++) {
        const p = paramsNode.child(i)!;
        if (p.type === "parameter") {
          params.push({
            name: p.childForFieldName("name")?.text ?? p.text,
            type: p.childForFieldName("type")?.text ?? null,
            defaultValue: p.childForFieldName("default_value")?.text ?? null,
          });
        }
      }
    }

    const returnType = node.childForFieldName("type")?.text ?? null;
    const isAsync = this.hasModifier(node, "async");
    const decorators: string[] = [];

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "attribute_list") {
        for (let j = 0; j < child.childCount; j++) {
          const attr = child.child(j)!;
          if (attr.type === "attribute") {
            decorators.push(attr.childForFieldName("name")?.text ?? attr.text);
          }
        }
      }
    }

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported: true,
      decorators,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private getCsharpVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "modifier") {
        if (child.text === "public") return "public";
        if (child.text === "private") return "private";
        if (child.text === "protected") return "protected";
      }
    }
    return null;
  }

  private hasModifier(node: Node, modifier: string): boolean {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "modifier" && child.text === modifier) return true;
    }
    return false;
  }
}
