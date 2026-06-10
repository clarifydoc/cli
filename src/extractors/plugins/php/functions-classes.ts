import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";

/**
 * PHP tree-sitter extractor.
 *
 * Recognises:
 *   - top-level `function_definition`
 *   - `class_declaration`, `interface_declaration`, `trait_declaration`, `enum_declaration`
 *   - PHP 8 `#[Attribute]` lists (mapped onto `decorators`)
 *   - PHP 8 constructor property promotion (`__construct(private Foo $bar)`)
 *   - return-type `optional_type`, `named_type`, `primitive_type`, `union_type`
 */
export class PhpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["php"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.children) {
      if (child.type === "function_definition") {
        functions.push(this.parseFunction(child));
      }
    }
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {
      if (
        child.type === "class_declaration" ||
        child.type === "interface_declaration" ||
        child.type === "trait_declaration" ||
        child.type === "enum_declaration"
      ) {
        classes.push(this.parseClass(child));
      }
    }
  }

  private parseFunction(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const params = this.parseParams(node.childForFieldName("parameters"));
    const returnType = this.parseReturnType(node);
    const body = node.childForFieldName("body");
    return {
      name,
      params,
      returnType,
      isAsync: false,
      isExported: true,
      decorators: this.parseAttributes(node),
      calls: extractCalls(body, "php"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private parseClass(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const kind = node.type === "interface_declaration" ? "interface" : "class";

    let extendsName: string | null = null;
    const impls: string[] = [];

    for (const c of node.children) {
      if (c.type === "base_clause") {
        // `class A extends B` — base_clause holds the parent name(s).
        for (const part of c.children) {
          if (part.type === "name" || part.type === "qualified_name") {
            extendsName = part.text.replace(/.*\\/, "");
            break;
          }
        }
      } else if (c.type === "class_interface_clause") {
        // `class A implements I1, I2`
        for (const part of c.children) {
          if (part.type === "name" || part.type === "qualified_name") {
            impls.push(part.text.replace(/.*\\/, ""));
          }
        }
      }
    }

    const body = node.childForFieldName("body") ?? this.findChildByType(node, "declaration_list");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (const member of body.children) {
        if (member.type === "method_declaration") {
          methods.push(this.parseMethod(member));
        } else if (member.type === "property_declaration") {
          this.collectProperties(member, properties);
        }
      }
    }

    return {
      name,
      extends: extendsName,
      implements: impls,
      decorators: this.parseAttributes(node),
      methods,
      properties,
      isExported: true,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind,
    };
  }

  private parseMethod(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const params = this.parseParams(node.childForFieldName("parameters"));
    const returnType = this.parseReturnType(node);
    const body = node.childForFieldName("body");
    return {
      name,
      params,
      returnType,
      isAsync: false,
      isExported: this.isPublicMember(node),
      decorators: this.parseAttributes(node),
      calls: extractCalls(body, "php"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  /**
   * Walk `formal_parameters`. Handles:
   *   - `simple_parameter` — `Type $name = default`
   *   - `property_promotion_parameter` — `private Type $name` (PHP 8)
   *   - `variadic_parameter` — `...$args`
   */
  private parseParams(paramsNode: Node | null): ParamInfo[] {
    const params: ParamInfo[] = [];
    if (!paramsNode) return params;

    for (const p of paramsNode.children) {
      if (
        p.type === "simple_parameter" ||
        p.type === "variadic_parameter" ||
        p.type === "property_promotion_parameter"
      ) {
        const varNode = this.findChildByType(p, "variable_name");
        const nameNode = varNode ? this.findChildByType(varNode, "name") : null;
        const pName = nameNode?.text ?? varNode?.text.replace(/^\$/, "") ?? "_";
        const typeText = this.parseParamType(p);
        const defaultNode = p.childForFieldName("default_value");
        params.push({
          name: pName,
          type: typeText,
          defaultValue: defaultNode?.text ?? null,
        });
      }
    }
    return params;
  }

  private parseParamType(p: Node): string | null {
    for (const c of p.children) {
      if (this.isTypeNode(c)) return this.normalizeType(c);
    }
    return null;
  }

  private parseReturnType(node: Node): string | null {
    // The return-type node sits between the closing `)` of formal_parameters
    // and the opening `{` of the body. We scan after `formal_parameters`.
    let sawParams = false;
    for (const c of node.children) {
      if (c.type === "formal_parameters") { sawParams = true; continue; }
      if (!sawParams) continue;
      if (c.type === "compound_statement" || c.type === ";") break;
      if (this.isTypeNode(c)) return this.normalizeType(c);
    }
    return null;
  }

  private isTypeNode(n: Node): boolean {
    return (
      n.type === "named_type" ||
      n.type === "primitive_type" ||
      n.type === "optional_type" ||
      n.type === "union_type" ||
      n.type === "intersection_type" ||
      n.type === "disjunctive_normal_form_type"
    );
  }

  private normalizeType(n: Node): string {
    // Strip nullable `?`, leading namespace separator, and namespace qualifier.
    return n.text.replace(/^\?/, "").replace(/^\\/, "").replace(/.*\\/, "").trim();
  }

  /** Walk a `property_declaration` and append every declared field. */
  private collectProperties(node: Node, out: PropertyInfo[]): void {
    let visibility: PropertyInfo["visibility"] = "public";
    let isStatic = false;
    let isReadonly = false;
    let typeText: string | null = null;

    for (const c of node.children) {
      if (c.type === "visibility_modifier") {
        const v = c.text.toLowerCase();
        if (v === "private" || v === "protected" || v === "public") visibility = v;
      } else if (c.type === "static_modifier") {
        isStatic = true;
      } else if (c.type === "readonly_modifier") {
        isReadonly = true;
      } else if (this.isTypeNode(c)) {
        typeText = this.normalizeType(c);
      } else if (c.type === "property_element") {
        const varNode = this.findChildByType(c, "variable_name");
        const nameNode = varNode ? this.findChildByType(varNode, "name") : null;
        const name = nameNode?.text ?? varNode?.text.replace(/^\$/, "") ?? null;
        if (name) {
          out.push({
            name,
            type: typeText,
            visibility,
            isStatic,
            isReadonly,
          });
        }
      }
    }
  }

  /** Map PHP 8 `#[Attribute(args)]` lists onto our `decorators` field. */
  private parseAttributes(node: Node): string[] {
    const decorators: string[] = [];
    for (const c of node.children) {
      if (c.type !== "attribute_list") continue;
      for (const group of c.children) {
        if (group.type !== "attribute_group") continue;
        for (const attr of group.children) {
          if (attr.type !== "attribute") continue;
          const nameNode = this.findChildByType(attr, "name") ?? this.findChildByType(attr, "qualified_name");
          if (nameNode) decorators.push(nameNode.text.replace(/^\\/, ""));
        }
      }
    }
    return decorators;
  }

  private isPublicMember(node: Node): boolean {
    // Treat default (no modifier) as public, matching PHP semantics.
    for (const c of node.children) {
      if (c.type === "visibility_modifier") {
        return c.text.toLowerCase() === "public";
      }
    }
    return true;
  }
}
