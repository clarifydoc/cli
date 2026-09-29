import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility,
  hasModifier as sharedHasModifier,
  extractCsharpAttributes,
} from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";

export class CSharpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["csharp"];

  protected collectFunctions(_node: Node, _functions: FunctionInfo[]): void {
    // C# functions are inside classes, handled in collectClasses
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractCsharpClasses(node, classes);
  }

  private extractCsharpClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {

      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body");
        if (body) this.extractCsharpClasses(body, classes);
        this.extractCsharpClasses(child, classes);
      } else if (
        child.type === "class_declaration" ||
        // Records (`record X(...)`, `record struct`, `record class`) and structs
        // are named types referenced across files exactly like classes — the CQRS
        // commands/queries in this codebase are ALL records, so without these the
        // symbol linker can't resolve `new XQuery()` / `Error.Forbidden` to their
        // definitions (it has no entry in the class catalog).
        child.type === "record_declaration" ||
        child.type === "struct_declaration"
      ) {
        classes.push(this.parseCsharpClass(child, "class"));
      } else if (child.type === "interface_declaration") {
        classes.push(this.parseCsharpClass(child, "interface"));
      } else if (child.type === "enum_declaration") {
        classes.push(this.parseCsharpEnum(child));
      }
    }
  }

  private parseCsharpClass(node: Node, kind: "class" | "interface"): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const bases = node.childForFieldName("bases")
      ?? this.findChildByType(node, "base_list");
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    if (bases) {
      for (const base of bases.children) {
        if (base.type !== "," && base.type !== ":") {
          if (!extendsName) {
            extendsName = base.text;
          } else {
            implementsList.push(base.text);
          }
        }
      }
    }

    const decorators = extractCsharpAttributes(node);

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (const member of body.children) {
        if (member.type === "method_declaration") {
          methods.push(this.parseCsharpMethod(member));
        } else if (member.type === "property_declaration") {
          const propName =
            member.childForFieldName("name")?.text ?? "unknown";
          const prop: PropertyInfo = {
            name: propName,
            type: member.childForFieldName("type")?.text ?? null,
            visibility: this.getCsharpVisibility(member),
            isStatic: this.hasModifier(member, "static"),
            isReadonly: this.hasModifier(member, "readonly"),
          };
          // `[Required]` / `[JsonPropertyName("x")]` and the C# 11 `required`
          // modifier are what a request schema needs; only set when present so
          // the per-file JSON of attribute-less models is unchanged in shape.
          const attrs = extractCsharpAttributes(member);
          if (attrs.length > 0) prop.decorators = attrs;
          if (this.hasModifier(member, "required")) prop.isRequired = true;
          properties.push(prop);
        } else if (member.type === "field_declaration") {
          // private readonly Foo _bar; — the tree-sitter shape is
          // field_declaration → variable_declaration { type, variable_declarator { name } }
          const typeText = member.childForFieldName("type")?.text
            ?? this.findChildByType(member, "variable_declaration")
              ?.childForFieldName("type")?.text
            ?? null;
          const varDecl = this.findChildByType(member, "variable_declaration");
          if (varDecl) {
            for (const decl of varDecl.children) {
              if (decl.type === "variable_declarator") {
                const fieldName = decl.childForFieldName("name")?.text ?? decl.text;
                properties.push({
                  name: fieldName,
                  type: typeText,
                  visibility: this.getCsharpVisibility(member),
                  isStatic: this.hasModifier(member, "static"),
                  isReadonly: this.hasModifier(member, "readonly"),
                });
              }
            }
          }
        }
      }
    }

    // C#: default class visibility is internal, check for public
    const classVis = this.getCsharpVisibility(node);
    return {
      name,
      extends: extendsName,
      implements: implementsList,
      decorators,
      methods,
      properties,
      isExported: classVis === "public" || classVis === null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind,
    };
  }

  /** `enum Role { Guest, Admin = 2 }` → a class of kind "enum" whose members are its properties. */
  private parseCsharpEnum(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body") ?? this.findChildByType(node, "enum_member_declaration_list");
    for (const member of body?.children ?? []) {
      if (member.type !== "enum_member_declaration") continue;
      const memberName = member.childForFieldName("name")?.text ?? this.findChildByType(member, "identifier")?.text;
      if (!memberName) continue;
      properties.push({ name: memberName, type: name, visibility: "public", isStatic: true, isReadonly: true });
    }
    const classVis = this.getCsharpVisibility(node);
    return {
      name,
      extends: null,
      implements: [],
      decorators: extractCsharpAttributes(node),
      methods: [],
      properties,
      isExported: classVis === "public" || classVis === null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind: "enum",
    };
  }

  private parseCsharpMethod(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (const p of paramsNode.children) {
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
    const decorators = extractCsharpAttributes(node);
    const body = node.childForFieldName("body");

    // C#: methods default to private
    const methodVis = this.getCsharpVisibility(node);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported: methodVis === "public",
      decorators,
      calls: extractCalls(body, "csharp"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private getCsharpVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return getVisibility(node);
  }

  private hasModifier(node: Node, modifier: string): boolean {
    return sharedHasModifier(node, modifier);
  }

}
