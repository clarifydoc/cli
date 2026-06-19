import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility as sharedGetVisibility,
  extractAnnotations as sharedExtractAnnotations,
  getNameFromNode,
} from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";

type JkLang = "java" | "kotlin";

export class JavaKotlinExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    // Only Kotlin has top-level functions; Java doesn't.
    const lang = detectLang(node);
    for (const child of node.children) {
      if (child.type === "function_declaration") {
        functions.push(this.parseMethod(child, "kotlin"));
      }
      // Kotlin top-level funcs may sit under a wrapping source_file node.
      if (child.type === "source_file" || child.type === "program") {
        this.collectFunctions(child, functions);
      }
    }
    void lang;
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.walkClasses(node, classes, detectLang(node));
  }

  private walkClasses(node: Node, classes: ClassInfo[], lang: JkLang): void {
    for (const child of node.children) {
      if (
        child.type === "class_declaration" ||
        child.type === "interface_declaration" ||
        child.type === "object_declaration" ||
        child.type === "enum_declaration"
      ) {
        classes.push(this.parseClass(child, lang));
      }

      if (child.type === "program" || child.type === "source_file") {
        this.walkClasses(child, classes, lang);
      }
    }
  }

  private parseClass(node: Node, lang: JkLang): ClassInfo {
    const name = this.getJkName(node);

    let extendsName: string | null = null;
    const implementsList: string[] = [];

    // Java: superclass / interfaces
    const superclass = node.childForFieldName("superclass");
    if (superclass) extendsName = superclass.text;

    const interfaces = node.childForFieldName("interfaces");
    if (interfaces) {
      for (const iface of interfaces.children) {
        if (iface.type !== "," && iface.type !== "implements") {
          implementsList.push(iface.text);
        }
      }
    }

    // Kotlin: delegation_specifiers (extends/implements combined)
    for (const child of node.children) {
      if (child.type === "delegation_specifiers" || child.type === "super_interfaces") {
        for (const spec of child.children) {
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
    // Java exposes the class body via the `body` field (class_body / interface_body /
    // enum_body); Kotlin's `class_declaration` has no such field — the body is a
    // `class_body` / `enum_class_body` CHILD. Falling through here is what left every
    // Kotlin class method-less (and the call graph blind to the whole server).
    const body =
      node.childForFieldName("body") ??
      this.findChildByType(node, "class_body") ??
      this.findChildByType(node, "enum_class_body") ??
      this.findChildByType(node, "interface_body") ??
      this.findChildByType(node, "enum_body");

    if (body) this.collectMembers(body, lang, methods, properties);

    // Java: default visibility is package-private (not public)
    // Kotlin: default visibility is public
    const vis = this.getVisibility(node);
    const isExported = lang === "kotlin" ? vis !== "private" : vis === "public" || vis === null;

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

  /** Collect methods + properties from a class/interface/enum/companion body. */
  private collectMembers(
    body: Node,
    lang: JkLang,
    methods: FunctionInfo[],
    properties: PropertyInfo[],
  ): void {
    for (const member of body.children) {
      if (
        member.type === "method_declaration" ||
        member.type === "function_declaration" ||
        member.type === "constructor_declaration" ||
        member.type === "secondary_constructor"
      ) {
        methods.push(this.parseMethod(member, lang));
      } else if (
        member.type === "field_declaration" ||
        member.type === "property_declaration"
      ) {
        const propName =
          member.childForFieldName("name")?.text ??
          this.findChildByType(member, "variable_declarator")?.childForFieldName("name")?.text ??
          this.findChildByType(member, "simple_identifier")?.text ??
          "unknown";
        const typeNode = member.childForFieldName("type") ?? this.findChildByType(member, "user_type");
        properties.push({
          name: propName,
          type: typeNode?.text ?? null,
          visibility: this.getVisibility(member),
          isStatic: member.text.includes("static ") || member.text.includes("companion"),
          isReadonly: member.text.includes("final ") || member.text.startsWith("val "),
        });
      } else if (member.type === "companion_object" || member.type === "object_declaration") {
        // Flatten companion / nested object members onto the class so their
        // calls and data access still attribute to a trace symbol.
        const inner = this.findChildByType(member, "class_body");
        if (inner) this.collectMembers(inner, lang, methods, properties);
      }
    }
  }

  private parseMethod(node: Node, language: JkLang): FunctionInfo {
    const name =
      this.getJkName(node) !== "anonymous"
        ? this.getJkName(node)
        : (node.type === "constructor_declaration" || node.type === "secondary_constructor"
            ? "constructor"
            : "anonymous");

    const paramsNode =
      node.childForFieldName("parameters") ??
      node.childForFieldName("value_parameters") ??
      this.findChildByType(node, "function_value_parameters") ??
      this.findChildByType(node, "formal_parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (const p of paramsNode.children) {
        if (
          p.type === "formal_parameter" ||
          p.type === "parameter" ||
          p.type === "spread_parameter"
        ) {
          const pName =
            p.childForFieldName("name")?.text ??
            this.findChildByType(p, "simple_identifier")?.text ??
            this.findChildByType(p, "identifier")?.text ??
            p.text;
          const pType =
            p.childForFieldName("type")?.text ??
            this.findChildByType(p, "user_type")?.text ??
            null;
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
      text.includes("Mono<") ||
      text.includes("@Async");

    const decorators = this.extractAnnotations(node);
    // Java: `body` field (block). Kotlin: a `function_body` CHILD (covers both the
    // `{ ... }` block and the `= expression` form). Without this fallback Kotlin
    // method bodies were never walked, so no calls / data access were extracted.
    const body =
      node.childForFieldName("body") ??
      this.findChildByType(node, "function_body") ??
      this.findChildByType(node, "constructor_body");

    // Check visibility: Java defaults to package-private, Kotlin defaults to public
    const vis = sharedGetVisibility(node);
    const isExported = language === "kotlin"
      ? vis !== "private"
      : vis === "public" || (node.type === "constructor_declaration");

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls: extractCalls(body, language),
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
}

/** Kotlin parses to a `source_file` root; Java to a `program` root. */
function detectLang(root: Node): JkLang {
  return root.type === "source_file" ? "kotlin" : "java";
}
