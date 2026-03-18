import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility as sharedGetVisibility,
  extractAnnotations as sharedExtractAnnotations,
  getNameFromNode,
} from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";

export class JavaKotlinExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    // Only Kotlin has top-level functions; Java doesn't
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "function_declaration") {
        functions.push(this.parseMethod(child, "kotlin"));
      }
    }
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.walkClasses(node, classes);
  }

  private walkClasses(node: Node, classes: ClassInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (
        child.type === "class_declaration" ||
        child.type === "interface_declaration" ||
        child.type === "object_declaration" ||
        child.type === "enum_declaration"
      ) {
        classes.push(this.parseClass(child));
      }

      if (child.type === "program" || child.type === "source_file") {
        this.walkClasses(child, classes);
      }
    }
  }

  private parseClass(node: Node): ClassInfo {
    const name = this.getJkName(node);

    let extendsName: string | null = null;
    const implementsList: string[] = [];

    // Java: superclass / interfaces
    const superclass = node.childForFieldName("superclass");
    if (superclass) extendsName = superclass.text;

    const interfaces = node.childForFieldName("interfaces");
    if (interfaces) {
      for (let i = 0; i < interfaces.childCount; i++) {
        const iface = interfaces.child(i)!;
        if (iface.type !== "," && iface.type !== "implements") {
          implementsList.push(iface.text);
        }
      }
    }

    // Kotlin: delegation_specifiers (extends/implements combined)
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "delegation_specifiers" || child.type === "super_interfaces") {
        for (let j = 0; j < child.childCount; j++) {
          const spec = child.child(j)!;
          if (spec.type !== "," && spec.type !== ":") {
            const specText = spec.text.replace(/\(.*\)$/, "").trim();
            if (!extendsName) {
              extendsName = specText;
            } else {
              implementsList.push(specText);
            }
          }
        }
      }
    }

    const decorators = this.extractAnnotations(node);

    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body");

    if (body) {
      for (let i = 0; i < body.childCount; i++) {
        const member = body.child(i)!;
        if (
          member.type === "method_declaration" ||
          member.type === "function_declaration" ||
          member.type === "constructor_declaration"
        ) {
          // Determine language from context: if node has delegation_specifiers it's Kotlin
          const lang = this.guessLanguage(node);
          methods.push(this.parseMethod(member, lang));
        } else if (
          member.type === "field_declaration" ||
          member.type === "property_declaration"
        ) {
          const propName =
            member.childForFieldName("name")?.text ??
            this.findChildByType(member, "variable_declarator")?.childForFieldName("name")?.text ??
            "unknown";
          const typeNode = member.childForFieldName("type");
          properties.push({
            name: propName,
            type: typeNode?.text ?? null,
            visibility: this.getVisibility(member),
            isStatic: member.text.includes("static ") || member.text.includes("companion"),
            isReadonly:
              member.text.includes("final ") || member.text.includes("val "),
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

  private parseMethod(node: Node, _language: string): FunctionInfo {
    const name =
      this.getJkName(node) !== "anonymous"
        ? this.getJkName(node)
        : (node.type === "constructor_declaration" ? "constructor" : "anonymous");

    const paramsNode =
      node.childForFieldName("parameters") ??
      node.childForFieldName("value_parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (let i = 0; i < paramsNode.childCount; i++) {
        const p = paramsNode.child(i)!;
        if (
          p.type === "formal_parameter" ||
          p.type === "parameter" ||
          p.type === "spread_parameter"
        ) {
          const pName = p.childForFieldName("name")?.text ?? p.text;
          const pType = p.childForFieldName("type")?.text ?? null;
          params.push({
            name: pName,
            type: pType,
            defaultValue: p.childForFieldName("value")?.text ?? null,
          });
        }
      }
    }

    const returnType =
      node.childForFieldName("type")?.text ??
      node.childForFieldName("return_type")?.text ??
      null;

    const text = node.text;
    const isAsync =
      text.includes("suspend ") ||
      text.includes("CompletableFuture") ||
      text.includes("Mono<");

    const decorators = this.extractAnnotations(node);
    const body = node.childForFieldName("body");
    const lang = _language === "kotlin" ? "kotlin" as const : "java" as const;

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported: true,
      decorators,
      calls: extractCalls(body, lang),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private getJkName(node: Node): string {
    return getNameFromNode(node) ?? "anonymous";
  }

  private extractAnnotations(node: Node): string[] {
    return sharedExtractAnnotations(node);
  }

  private getVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return sharedGetVisibility(node);
  }

  /** Heuristic: if the node tree has Kotlin-specific constructs, it's Kotlin */
  private guessLanguage(node: Node): string {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
      if (child.type === "delegation_specifiers" || child.type === "type_parameters") {
        return "kotlin";
      }
    }
    return "java";
  }
}
