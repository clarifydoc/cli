import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility as sharedGetVisibility,
  extractAnnotations as sharedExtractAnnotations,
  getNameFromNode,
} from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";
import { simpleTypeName } from "../../shared/type-parser.js";

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
        child.type === "enum_declaration" ||
        child.type === "record_declaration"
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
    // The `superclass` node's text carries the keyword (`extends Base`);
    // consumers resolve the NAME, so strip it — with the keyword in, a DTO's
    // base class never joined its request schema.
    if (superclass) extendsName = superclass.text.replace(/^extends\s+/, "").trim();

    const interfaces = node.childForFieldName("interfaces");
    if (interfaces) {
      for (const iface of interfaces.children) {
        if (iface.type !== "," && iface.type !== "implements") {
          implementsList.push(iface.text);
        }
      }
    }

    // Kotlin: one `delegation_specifier` child per supertype (`: Base(), IFoo`).
    // The grammar has no plural wrapper — the previous `delegation_specifiers`
    // lookup never matched, so Kotlin extends/implements were always empty
    // (interface→impl resolution couldn't find the impl). A `()` constructor
    // call marks the superCLASS (Kotlin requires it); a bare name is an interface.
    for (const child of node.children) {
      if (child.type !== "delegation_specifier") continue;
      const specText = child.text.replace(/[<(].*$/s, "").trim();
      if (!specText) continue;
      if (child.text.includes("(") && !extendsName) {
        extendsName = specText;
      } else {
        implementsList.push(specText);
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
    // Kotlin `data class Dto(val a: String)` and a Java `record Dto(String a)`
    // declare their fields in the header, not the body — the request-model
    // shape in both languages. Without these, DTOs have zero properties.
    this.collectHeaderProperties(node, lang, properties);

    // Java: default visibility is package-private (not public)
    // Kotlin: default visibility is public
    const vis = this.getVisibility(node);
    const isExported = lang === "kotlin" ? vis !== "private" : vis === "public" || vis === null;

    // Kotlin parses `interface X` as a class_declaration carrying an `interface`
    // keyword token; Java uses a dedicated `interface_declaration`. Marking
    // `kind` is what lets `buildInterfaceImplMap` seed the interface (and thus
    // redirect `this.service.X()` to the implementing class's method).
    const isInterface =
      node.type === "interface_declaration" ||
      node.children.some((c) => c.type === "interface");
    // Java `enum X { A, B }` / Kotlin `enum class X { A, B }`: the constants
    // are the members a request schema lists.
    const isEnum = node.type === "enum_declaration" || node.children.some((c) => c.type === "enum");
    if (isEnum && body) {
      for (const c of body.children) {
        const constName =
          c.type === "enum_constant" ? c.childForFieldName("name")?.text ?? this.findChildByType(c, "identifier")?.text
          : c.type === "enum_entry" ? this.findChildByType(c, "simple_identifier")?.text
          : undefined;
        if (constName) properties.push({ name: constName, type: name, visibility: "public", isStatic: true, isReadonly: true });
      }
    }

    return {
      name,
      kind: isInterface ? "interface" : isEnum ? "enum" : "class",
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
        // Kotlin nests the name + type inside a `variable_declaration`
        // (`service: IAppService`); Java uses a `variable_declarator` + `type`
        // field. Getting the name/type right is what lets the injection map
        // resolve `this.service.X()` → the service class (DI-style fields).
        const varDecl = this.findChildByType(member, "variable_declaration");
        const propName =
          member.childForFieldName("name")?.text ??
          this.findChildByType(member, "variable_declarator")?.childForFieldName("name")?.text ??
          (varDecl && this.findChildByType(varDecl, "simple_identifier")?.text) ??
          this.findChildByType(member, "simple_identifier")?.text ??
          "unknown";
        const typeNode =
          member.childForFieldName("type") ??
          (varDecl && (this.findChildByType(varDecl, "user_type") ?? this.findChildByType(varDecl, "nullable_type"))) ??
          this.findChildByType(member, "user_type") ??
          this.findChildByType(member, "nullable_type");
        const prop: PropertyInfo = {
          name: propName,
          type: typeNode?.text ?? null,
          visibility: this.getVisibility(member),
          isStatic: member.text.includes("static ") || member.text.includes("companion"),
          isReadonly: member.text.includes("final ") || member.text.startsWith("val "),
        };
        // `@JsonProperty("x")` / `@NotNull` — what the request schema reads.
        const attrs = this.extractAnnotations(member).map((a) => a.replace(/\s+/g, " "));
        if (attrs.length > 0) prop.decorators = attrs;
        properties.push(prop);
      } else if (member.type === "companion_object" || member.type === "object_declaration") {
        // Flatten companion / nested object members onto the class so their
        // calls and data access still attribute to a trace symbol.
        const inner = this.findChildByType(member, "class_body");
        if (inner) this.collectMembers(inner, lang, methods, properties);
      }
    }
  }

  /**
   * Header-declared fields: Kotlin primary-constructor `val`/`var` parameters
   * and Java record components. A Kotlin parameter without `val`/`var` is a
   * constructor argument only and is skipped. `isRequired` marks a Kotlin
   * non-nullable parameter with no default — the one a caller must send.
   */
  private collectHeaderProperties(node: Node, lang: JkLang, properties: PropertyInfo[]): void {
    if (node.type === "record_declaration") {
      const params = node.childForFieldName("parameters") ?? this.findChildByType(node, "formal_parameters");
      for (const p of params?.children ?? []) {
        if (p.type !== "formal_parameter") continue;
        const prop: PropertyInfo = {
          name: p.childForFieldName("name")?.text ?? "unknown",
          type: p.childForFieldName("type")?.text ?? null,
          visibility: "public",
          isStatic: false,
          isReadonly: true,
        };
        const attrs = this.extractAnnotations(p).map((a) => a.replace(/\s+/g, " "));
        if (attrs.length > 0) prop.decorators = attrs;
        properties.push(prop);
      }
      return;
    }
    if (lang !== "kotlin") return;
    const ctor = this.findChildByType(node, "primary_constructor");
    if (!ctor) return;
    for (const p of ctor.children) {
      if (p.type !== "class_parameter") continue;
      const kind = this.findChildByType(p, "binding_pattern_kind")?.text;
      if (kind !== "val" && kind !== "var") continue;
      const name = this.findChildByType(p, "simple_identifier")?.text ?? "unknown";
      const typeNode = p.children.find((c) =>
        c.type === "user_type" || c.type === "nullable_type" || c.type === "function_type" || c.type === "parenthesized_type",
      );
      const hasDefault = p.children.some((c) => c.type === "=");
      const prop: PropertyInfo = {
        name,
        type: typeNode?.text ?? null,
        visibility: this.getVisibility(p) ?? "public",
        isStatic: false,
        isReadonly: kind === "val",
      };
      const attrs = this.extractAnnotations(p).map((a) => a.replace(/\s+/g, " "));
      if (attrs.length > 0) prop.decorators = attrs;
      if (!hasDefault && typeNode && typeNode.type !== "nullable_type") prop.isRequired = true;
      properties.push(prop);
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

    const localTypes = extractLocalTypes(body);
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
      ...(localTypes.length > 0 ? { localTypes } : {}),
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

/**
 * Kotlin name + declared type of a declaration-shaped node. tree-sitter-kotlin
 * exposes few fields, so this is the ONE place that knows where they live:
 * `property_declaration` carries them under its `variable_declaration` child;
 * `class_parameter` / `parameter` carry them directly. Either half may be null.
 */
export function kotlinNameAndType(node: Node): { name: string | null; type: string | null } {
  const holder = node.children.find((c) => c.type === "variable_declaration") ?? node;
  const name = holder.children.find((c) => c.type === "simple_identifier")?.text ?? null;
  const type =
    holder.children.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text ?? null;
  return { name, type };
}

/**
 * Declared-type locals of a method body → `FunctionInfo.localTypes`
 * (`Account existing = repo.find(id)` → {existing, Account}), the same channel
 * PHP populates for `$x = new Foo()`. The symbol linker uses these both to
 * RESOLVE calls through a typed local (Strategy 2) and to VETO unique-name
 * guesses whose receiver's declared type contradicts the target (Strategy 7).
 * Java: `local_variable_declaration` + enhanced-for; Kotlin: typed
 * `val x: Type` locals (type-inferred locals carry no evidence — skipped).
 * Only PascalCase class-like simple types are kept (`var`, primitives, and
 * generic containers say nothing about the receiver's own members). Nested
 * lambdas/anonymous classes are walked too — a shadowed name keeps the FIRST
 * sighting, matching top-down reading order.
 */
function extractLocalTypes(body: Node | null): Array<{ name: string; type: string }> {
  if (!body) return [];
  const out: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();
  const push = (name: string | null | undefined, rawType: string | null | undefined) => {
    if (!name || seen.has(name)) return;
    const simple = simpleTypeName(rawType);
    if (!simple || !/^[A-Z]/.test(simple) || simple === "String") return;
    seen.add(name);
    out.push({ name, type: simple });
  };
  const visit = (n: Node): void => {
    if (n.type === "local_variable_declaration" || n.type === "enhanced_for_statement") {
      const type = n.childForFieldName("type")?.text;
      if (n.type === "enhanced_for_statement") {
        push(n.childForFieldName("name")?.text, type);
      } else {
        for (const c of n.children) {
          if (c.type === "variable_declarator") push(c.childForFieldName("name")?.text, type);
        }
      }
    } else if (n.type === "property_declaration") {
      // Kotlin `val x: Type = …` local (class-level properties never reach
      // here — this walks a function body only).
      const { name, type } = kotlinNameAndType(n);
      push(name, type);
    }
    for (const child of n.children) visit(child);
  };
  visit(body);
  return out;
}
