import { constantString } from "./constant-expr.js";
import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility as sharedGetVisibility,
  extractAnnotations as sharedExtractAnnotations,
  getNameFromNode,
} from "../../shared/node-helpers.js";
import { callChainText, extractCalls } from "../../shared/call-graph.js";
import { simpleTypeName } from "../../shared/type-parser.js";
import { annotationNodes, isInjectMarked, pointQualifier } from "./di-annotations.js";
import { javalinSparkAccess } from "./routes/javalin-spark.js";
import { expressionFact, koinQualifier, type ExprFact } from "./di-expressions.js";
import { typeVariableArgs } from "./arg-kinds.js";

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

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
        this.walkNestedClasses(child, classes, lang);
      } else if (child.type === "type_alias") {
        const alias = typeAliasClass(child);
        if (alias) classes.push(alias);
      }

      if (child.type === "program" || child.type === "source_file") {
        this.walkClasses(child, classes, lang);
      }
    }
  }

  /**
   * Types declared inside a class body (`static class Builder`, a JUnit
   * `@Nested` class, Kotlin `class Inner`) are classes of their own, named as
   * code refers to them (`Builder`). A Kotlin `object` / companion is not: its
   * members are folded onto the enclosing class.
   */
  private walkNestedClasses(owner: Node, classes: ClassInfo[], lang: JkLang): void {
    const body = owner.childForFieldName("body") ?? this.findChildByType(owner, "class_body") ?? this.findChildByType(owner, "enum_class_body");
    for (const member of body?.children ?? []) {
      if (
        member.type === "class_declaration" ||
        member.type === "interface_declaration" ||
        member.type === "enum_declaration" ||
        member.type === "record_declaration"
      ) {
        classes.push(this.parseClass(member, lang));
        this.walkNestedClasses(member, classes, lang);
      }
    }
  }

  private parseClass(node: Node, lang: JkLang): ClassInfo {
    const name = this.getJkName(node);

    const { extendsName, implementsList } = jvmSupertypes(node);

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

    // Kotlin primary constructor: ALL its parameters (a plain `repo: Repo` is
    // an injection point too — copied into a property, or used by `init`), as
    // a `constructor` method the DI resolution reads.
    const primary = lang === "kotlin" ? this.parsePrimaryConstructor(node) : null;
    if (primary) methods.push(primary);
    if (body) this.collectMembers(body, lang, methods, properties, primary);
    // Kotlin `data class Dto(val a: String)` and a Java `record Dto(String a)`
    // declare their fields in the header, not the body — the request-model
    // shape in both languages. Without these, DTOs have zero properties.
    this.collectHeaderProperties(node, lang, properties, primary);
    if (lang === "java") propagateCtorQualifiers(methods, properties, body, name);

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

    const strings = body ? stringConstants(body) : null;
    return {
      name,
      kind: isInterface ? "interface" : isEnum ? "enum" : "class",
      extends: extendsName,
      implements: implementsList,
      decorators,
      methods,
      properties,
      ...(strings ? { fieldValues: strings } : {}),
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
    primary: FunctionInfo | null,
  ): void {
    for (const member of body.children) {
      // A Java enum's fields, constructor and methods follow its constants
      // inside an `enum_body_declarations` node.
      if (member.type === "enum_body_declarations") {
        this.collectMembers(member, lang, methods, properties, primary);
      } else if (
        member.type === "method_declaration" ||
        member.type === "function_declaration" ||
        member.type === "constructor_declaration" ||
        member.type === "secondary_constructor"
      ) {
        methods.push(this.parseMethod(member, lang));
      } else if (
        member.type === "field_declaration" ||
        member.type === "property_declaration" ||
        member.type === "constant_declaration"
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
          // An interface's fields are implicitly `static final`.
          isStatic: member.type === "constant_declaration" || member.text.includes("static ") || member.text.includes("companion"),
          isReadonly: member.type === "constant_declaration" || member.text.includes("final ") || member.text.startsWith("val "),
        };
        // `@JsonProperty("x")` / `@NotNull` — what the request schema reads.
        const attrs = this.extractAnnotations(member).map((a) => a.replace(/\s+/g, " "));
        if (attrs.length > 0) prop.decorators = attrs;
        // The DI key the field is injected by (`@Autowired @Qualifier("disk")`,
        // `@Inject @Named("x")`), and — for an untyped Kotlin property — the
        // type its delegate or initializer states (`by inject<Repo>()`,
        // `= plainRepo` copying a constructor parameter, `= Repo()`).
        const anns = annotationNodes(member);
        let qualifier = pointQualifier(anns, propName, isInjectMarked(anns));
        if (lang === "kotlin") {
          const fact = kotlinPropertyFact(member, primary);
          if (fact) {
            if (!prop.type && fact.type) prop.type = fact.type;
            qualifier ??= fact.qualifier;
          }
        }
        if (qualifier) prop.qualifier = qualifier;
        properties.push(prop);
      } else if (member.type === "companion_object" || member.type === "object_declaration") {
        // Flatten companion / nested object members onto the class so their
        // calls and data access still attribute to a trace symbol.
        const inner = this.findChildByType(member, "class_body");
        if (inner) this.collectMembers(inner, lang, methods, properties, null);
      }
    }
  }

  /**
   * A Kotlin primary constructor as a `constructor` method carrying ALL its
   * parameters — `val`/`var` ones (also properties) and plain ones
   * (`plainRepo: Repo`, visible to property initializers and `init` blocks) —
   * with their declared types and DI keys. Null when it declares none.
   * Annotations on it (`@Inject constructor(…)`) are its decorators, and make
   * every parameter an explicit injection point.
   */
  private parsePrimaryConstructor(node: Node): FunctionInfo | null {
    const ctor = this.findChildByType(node, "primary_constructor");
    if (!ctor) return null;
    const ctorAnns = annotationNodes(ctor);
    const explicit = isInjectMarked(ctorAnns);
    const params: ParamInfo[] = [];
    for (const p of ctor.children) {
      if (p.type !== "class_parameter") continue;
      const name = this.findChildByType(p, "simple_identifier")?.text ?? "unknown";
      const eq = p.children.findIndex((c) => c.type === "=");
      const param: ParamInfo = {
        name,
        type: kotlinTypeChild(p)?.text ?? null,
        defaultValue: eq >= 0 ? p.children[eq + 1]?.text ?? null : null,
      };
      const qualifier = pointQualifier(annotationNodes(p), name, explicit);
      if (qualifier) param.qualifier = qualifier;
      params.push(param);
    }
    if (params.length === 0) return null;
    // `private constructor(…)` — read the constructor's own modifiers, not its
    // text (which carries every `private val` parameter).
    const isPrivate = ctor.children
      .find((c) => c.type === "modifiers")
      ?.children.some((m) => m.type === "visibility_modifier" && m.text === "private") ?? false;
    return {
      name: "constructor",
      params,
      returnType: null,
      isAsync: false,
      isExported: !isPrivate,
      decorators: this.extractAnnotations(ctor).map((a) => a.replace(/\s+/g, " ")),
      calls: [],
      line: ctor.startPosition.row + 1,
      endLine: ctor.endPosition.row + 1,
    };
  }

  /**
   * Header-declared fields: Kotlin primary-constructor `val`/`var` parameters
   * and Java record components. A Kotlin parameter without `val`/`var` is a
   * constructor argument only and is skipped (the `constructor` method carries
   * it). `isRequired` marks a Kotlin non-nullable parameter with no default —
   * the one a caller must send.
   */
  private collectHeaderProperties(node: Node, lang: JkLang, properties: PropertyInfo[], primary: FunctionInfo | null): void {
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
      const typeNode = kotlinTypeChild(p);
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
      const qualifier = primary?.params.find((q) => q.name === name)?.qualifier;
      if (qualifier) prop.qualifier = qualifier;
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
    // `@Inject` / `@Autowired` on the method or constructor makes every
    // parameter an explicit injection point (custom qualifier annotations count).
    const explicit = isInjectMarked(annotationNodes(node));

    if (paramsNode) {
      for (const p of paramsNode.children) {
        if (
          p.type === "formal_parameter" ||
          p.type === "parameter" ||
          p.type === "spread_parameter"
        ) {
          const pName =
            p.childForFieldName("name")?.text ??
            // `String... parts`: the name sits in the spread's declarator.
            (p.type === "spread_parameter" ? this.findChildByType(p, "variable_declarator")?.childForFieldName("name")?.text : undefined) ??
            this.findChildByType(p, "simple_identifier")?.text ??
            this.findChildByType(p, "identifier")?.text ??
            p.text;
          // Kotlin names no fields: the type is the child after `:` — a
          // `user_type`, or a `nullable_type` for `r: Repo?` (which the
          // `user_type`-only lookup used to drop).
          const pType =
            p.childForFieldName("type")?.text ??
            (language === "kotlin" ? kotlinTypeChild(p)?.text : this.findChildByType(p, "user_type")?.text) ??
            null;
          const param: ParamInfo = {
            name: pName,
            type: pType,
            defaultValue: p.childForFieldName("value")?.text ?? null,
          };
          const qualifier = pointQualifier(annotationNodes(p), pName, explicit);
          if (qualifier) param.qualifier = qualifier;
          // `String... parts` / Kotlin `vararg parts: String`: any number of trailing arguments.
          if (p.type === "spread_parameter" || p.previousSibling?.text.includes("vararg")) param.variadic = true;
          params.push(param);
        }
      }
    }

    // Kotlin extension function (`fun Band.addRow()`): the receiver is the
    // method's implicit first parameter — it is called as `band.addRow()` on
    // that type although no class of it declares `addRow`.
    if (language === "kotlin" && node.type === "function_declaration") {
      const receiver = kotlinReceiverType(node);
      if (receiver) params.unshift({ name: "this", type: receiver, defaultValue: null, isReceiver: true });
    }

    // Java: the `type` field. Kotlin names no field: the return type is the
    // type node after the `:` that follows the parameter list.
    const returnType =
      node.childForFieldName("type")?.text ??
      node.childForFieldName("return_type")?.text ??
      (language === "kotlin" ? kotlinReturnType(node) : null);

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

    const localTypes = extractLocalTypes(body, language);
    // The container calls a provider method (`@Bean`, `@Provides`,
    // `@Produces`) and an `@Inject`/`@Autowired` method with its parameters
    // resolved: container registrations decide them. Any other method's
    // parameters are whatever its caller passes.
    if (decorators.some((d) => /^(?:[\w.]+\.)?(?:Bean|Provides|Produces|Inject|Autowired)\b/.test(d))) {
      for (const p of params) if (!p.isReceiver) p.injected = true;
    }
    // A Javalin `Context` / Spark `Request` handler method: what its body reads off the request.
    const reqParam = params.find((p) => !p.isReceiver && /^(?:io\.javalin\.http\.)?Context$|^(?:spark\.)?Request$/.test(p.type ?? ""));
    const requestAccess = reqParam && body ? javalinSparkAccess(body.text, reqParam.name, /Context$/.test(reqParam.type!) ? "javalin" : "spark") : [];
    const calls = extractCalls(body, language);
    typeVariableArgs(calls, params, body, language);
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      ...(requestAccess.length > 0 ? { requestAccess } : {}),
      calls,
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

/** The declared-type child of a Kotlin `parameter` / `class_parameter` (after its `:`). */
function kotlinTypeChild(p: Node): Node | null {
  return p.children.find((c) => KOTLIN_TYPE_NODES.has(c.type)) ?? null;
}

const KOTLIN_TYPE_NODES: ReadonlySet<string> = new Set(["user_type", "nullable_type", "function_type", "parenthesized_type"]);

/** Kotlin `fun f(…): T` → `T` (the type node after the `:` that follows the parameter list). */
function kotlinReturnType(fn: Node): string | null {
  const kids = fn.children;
  const params = kids.findIndex((c) => c.type === "function_value_parameters");
  if (params < 0) return null;
  for (let i = params + 1; i < kids.length; i++) {
    const k = kids[i]!;
    if (k.type === "function_body" || k.type === "type_constraints") return null;
    if (k.type === ":") {
      const t = kids[i + 1];
      return t && KOTLIN_TYPE_NODES.has(t.type) ? t.text : null;
    }
  }
  return null;
}

/** Kotlin `fun Band.f()` / `fun <T> List<T>.f()` / `fun Foo?.f()` → the receiver type as written. */
function kotlinReceiverType(fn: Node): string | null {
  const kids = fn.children;
  const name = kids.findIndex((c) => c.type === "simple_identifier");
  if (name < 2 || kids[name - 1]!.type !== ".") return null;
  const t = kids[name - 2]!;
  return KOTLIN_TYPE_NODES.has(t.type) ? t.text : null;
}

/**
 * Supertypes of a Java/Kotlin class-like declaration, one entry per type.
 *
 * A class's `extends` is a NAME (type arguments stripped — consumers look
 * classes up by it); `implements` keeps each type as written
 * (`Repository<Order>`), core strips what it needs. An interface has no
 * runtime base: its first super-interface is `extends` (so inherited-method
 * lookups walk to it), as written like `implements` — a Spring Data
 * repository's `JpaRepository<Match, Long>` names its entity — and the rest
 * ride along in `implements`: the TypeScript plugin's convention.
 *
 * Java: `superclass` / `interfaces` (`super_interfaces > type_list`) fields;
 * an interface's `extends_interfaces > type_list`. Kotlin: one
 * `delegation_specifier` per supertype (`: Base(), I, J by impl`) — a
 * constructor call marks the superclass, a bare type an interface.
 */
export function jvmSupertypes(node: Node): { extendsName: string | null; implementsList: string[] } {
  let extendsName: string | null = null;
  const implementsList: string[] = [];
  const typeListEntries = (holder: Node | null | undefined): string[] => {
    const list = holder?.children.find((c) => c.type === "type_list");
    return (list?.namedChildren ?? []).map((t) => t.text.replace(/\s+/g, " ").trim()).filter(Boolean);
  };

  // The `superclass` node carries the keyword (`extends Base<T>`); consumers
  // resolve the NAME, so keep the type only — with the keyword in, a DTO's
  // base class never joined its request schema.
  const superclass = node.childForFieldName("superclass");
  if (superclass) {
    const t = superclass.namedChildren[superclass.namedChildren.length - 1];
    extendsName = stripTypeArgs(t ? t.text : superclass.text.replace(/^extends\s+/, ""));
  }
  implementsList.push(...typeListEntries(node.childForFieldName("interfaces")));
  if (node.type === "interface_declaration") {
    implementsList.push(...typeListEntries(node.children.find((c) => c.type === "extends_interfaces")));
  }

  for (const child of node.children) {
    if (child.type !== "delegation_specifier") continue;
    const ctorCall = child.children.find((c) => c.type === "constructor_invocation");
    const typeNode =
      ctorCall?.children.find((c) => c.type === "user_type") ??
      child.children.find((c) => c.type === "user_type") ??
      child.children.find((c) => c.type === "explicit_delegation")?.children.find((c) => c.type === "user_type");
    const specText = stripTypeArgs(typeNode?.text ?? child.text.replace(/[<(].*$/s, ""));
    if (!specText) continue;
    if (ctorCall && !extendsName) extendsName = specText;
    else implementsList.push(specText);
  }

  const isInterface = node.type === "interface_declaration" || node.children.some((c) => c.type === "interface");
  if (isInterface && !extendsName && implementsList.length > 0) {
    extendsName = implementsList.shift()!;
  }
  return { extendsName, implementsList };
}

/** `Base<T>` → `Base`; `com.x.Base<T>` → `com.x.Base` (whitespace removed). */
function stripTypeArgs(text: string): string {
  return text.replace(/<[\s\S]*$/, "").replace(/\s+/g, "").trim();
}

/**
 * Class-level copies of an injected constructor parameter (Java
 * `this.encoder = encoder;`): the field is the injection point core reads, so
 * it takes the parameter's DI key (`@Qualifier("xmlEncoder") Encoder encoder`)
 * when it declares none itself.
 */
function propagateCtorQualifiers(methods: FunctionInfo[], properties: PropertyInfo[], body: Node | null, className: string): void {
  if (!body) return;
  const ctors = methods.filter((m) => m.name === className && m.params.some((p) => p.qualifier));
  if (ctors.length === 0) return;
  for (const member of body.children) {
    if (member.type !== "constructor_declaration") continue;
    const params = member.childForFieldName("parameters");
    const qualifiers = new Map<string, string>();
    for (const p of params?.namedChildren ?? []) {
      if (p.type !== "formal_parameter") continue;
      const name = p.childForFieldName("name")?.text;
      if (!name) continue;
      const q = pointQualifier(annotationNodes(p), name, isInjectMarked(annotationNodes(member)));
      if (q) qualifiers.set(name, q);
    }
    if (qualifiers.size === 0) continue;
    const ctorBody = member.childForFieldName("body");
    for (const stmt of ctorBody?.namedChildren ?? []) {
      if (stmt.type !== "expression_statement") continue;
      const assign = stmt.namedChildren[0];
      if (assign?.type !== "assignment_expression") continue;
      const left = assign.childForFieldName("left");
      const right = assign.childForFieldName("right");
      if (!left || right?.type !== "identifier") continue;
      const field =
        left.type === "field_access" && left.childForFieldName("object")?.type === "this" ? left.childForFieldName("field")?.text
        : left.type === "identifier" ? left.text
        : undefined;
      const q = qualifiers.get(right.text);
      if (!field || !q) continue;
      const prop = properties.find((pr) => pr.name === field);
      if (prop && !prop.qualifier) prop.qualifier = q;
    }
  }
}

/**
 * What an untyped Kotlin property's delegate or initializer states:
 *   `by inject<Repo>()` / `by inject(named("x"))` / `by viewModel<Vm>()` (Koin),
 *   `by lazy { Repo() }`, `= plainRepo` (a primary-constructor parameter — its
 *   type and DI key), `= Repo()` / `= get<Repo>()` / `= ctx.getBean(…)`.
 * For a typed property only the key part matters (`val r: Repo by inject(named("x"))`).
 */
function kotlinPropertyFact(member: Node, primary: FunctionInfo | null): ExprFact | null {
  const delegate = member.children.find((c) => c.type === "property_delegate");
  if (delegate) {
    const call = delegate.namedChildren[0];
    if (call?.type !== "call_expression") return null;
    const callee = call.children[0];
    const suffix = call.children.find((c) => c.type === "call_suffix");
    if (!callee || !suffix) return null;
    const name = callee.type === "simple_identifier" ? callee.text : null;
    if (name === "lazy") {
      const lambda = suffix.children.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal");
      return lastExpressionFact(lambda);
    }
    if (!name || !DELEGATE_LOOKUPS.has(name)) return null;
    const fact: ExprFact = {};
    const typeArg = suffix.children.find((c) => c.type === "type_arguments")?.namedChildren[0]?.namedChildren[0];
    if (typeArg) {
      const t = simpleTypeName(typeArg.text);
      if (t) fact.type = t;
    }
    const args = suffix.children.find((c) => c.type === "value_arguments");
    for (const v of args?.namedChildren ?? []) {
      const q = koinQualifier(v.namedChildren[v.namedChildren.length - 1] ?? v);
      if (q) fact.qualifier = q;
    }
    return fact.type || fact.qualifier ? fact : null;
  }
  const eq = member.children.findIndex((c) => c.type === "=");
  const init = eq >= 0 ? member.children[eq + 1] : undefined;
  if (!init) return null;
  if (init.type === "simple_identifier") {
    const param = primary?.params.find((p) => p.name === init.text);
    if (!param?.type) return null;
    return param.qualifier ? { type: param.type, qualifier: param.qualifier } : { type: param.type };
  }
  return expressionFact(init);
}

/** Delegates that look the property's type up in a container (Koin `inject`, Android/Koin view-model delegates). */
const DELEGATE_LOOKUPS: ReadonlySet<string> = new Set([
  "inject", "injectOrNull", "viewModel", "viewModels", "activityViewModels", "sharedViewModel", "activityViewModel", "koinViewModel",
]);

/** The fact for the last statement of a Kotlin lambda (`lazy { Repo() }`, a Koin definition body). */
export function lastExpressionFact(lambda: Node | null | undefined): ExprFact | null {
  const stmts = lambda?.children.find((c) => c.type === "statements");
  const last = stmts?.namedChildren[stmts.namedChildren.length - 1];
  return expressionFact(last);
}

/**
 * Locals of a method body whose type the body states → `FunctionInfo.localTypes`
 * (`Account existing = repo.find(id)` → {existing, Account}), the same channel
 * PHP populates for `$x = new Foo()`. The symbol linker uses these both to
 * RESOLVE calls through a typed local (Strategy 2) and to VETO unique-name
 * guesses whose receiver's declared type contradicts the target (Strategy 7).
 *
 * Java: `local_variable_declaration` + enhanced-for; a `var` local takes the
 * type its initializer states. Kotlin: `val x: Type` locals, and untyped ones
 * whose initializer states it. Initializers that state a type: a
 * construction (`new Foo()`, Kotlin `Foo()`), a container lookup
 * (`getBean(Foo.class)`, `getBean("n", Foo.class)`, `injector.getInstance(
 * Key.get(Foo.class, Names.named("n")))`, Koin `get<Foo>(named("n"))`), a cast
 * (`(Foo) ctx.getBean("n")`, `… as Foo`). A lookup's key rides along as the
 * local's `qualifier` — also on an explicitly typed local (`val r: Repo =
 * get(named("n"))`).
 *
 * Only PascalCase class-like simple types are kept (primitives and `String`
 * say nothing about the receiver's own members). Nested lambdas/anonymous
 * classes are walked too — a shadowed name keeps the FIRST sighting, matching
 * top-down reading order.
 */
function extractLocalTypes(body: Node | null, language: JkLang): LocalType[] {
  if (!body) return [];
  const out: LocalType[] = [];
  const seen = new Set<string>();
  // Initializer calls wait: a type the body states anywhere beats them. Each
  // distinct call is kept (locals of one name in sibling blocks); the linker
  // types the local only when their return types agree.
  const fromCalls = new Map<string, Set<string>>();
  const push = (name: string | null | undefined, rawType: string | null | undefined, init?: Node | null) =>
    pushFact(name, rawType, init ? expressionFact(init) : null, init);
  const pushFact = (name: string | null | undefined, rawType: string | null | undefined, fact: ExprFact | null, init?: Node | null) => {
    if (!name || seen.has(name)) return;
    let declared = rawType && rawType !== "var" ? rawType : null;
    if (!declared && fact?.type) declared = fact.type;
    if (!declared && !fact?.qualifier) {
      // `var dao = DaoFactory.getDAO()` / `val case = repo.find(id)` — typed
      // by what the call is declared to return; the linker reads that.
      const from = callChainText(init, language);
      if (from) fromCalls.set(name, (fromCalls.get(name) ?? new Set()).add(from));
      return;
    }
    const simple = simpleTypeName(declared);
    if (!simple || !/^[A-Z]/.test(simple) || simple === "String") return;
    seen.add(name);
    const entry: LocalType = { name, type: simple };
    if (fact?.qualifier) entry.qualifier = fact.qualifier;
    out.push(entry);
  };
  const visit = (n: Node): void => {
    if (n.type === "local_variable_declaration" || n.type === "enhanced_for_statement") {
      const type = n.childForFieldName("type")?.text;
      if (n.type === "enhanced_for_statement") {
        push(n.childForFieldName("name")?.text, type);
      } else {
        for (const c of n.children) {
          if (c.type === "variable_declarator") push(c.childForFieldName("name")?.text, type, c.childForFieldName("value"));
        }
      }
    } else if (language === "kotlin" && n.type === "property_declaration") {
      // Kotlin `val x: Type = …` / `val x = …` local (class-level properties
      // never reach here — this walks a function body only).
      const { name, type } = kotlinNameAndType(n);
      const eq = n.children.findIndex((c) => c.type === "=");
      if (eq >= 0) push(name, type, n.children[eq + 1]);
      else {
        // A local delegated property: `val repo by inject<Repo>()`, `by lazy { Repo() }`.
        const fact = n.children.some((c) => c.type === "property_delegate") ? kotlinPropertyFact(n, null) : null;
        pushFact(name, type, fact);
      }
    }
    for (const child of n.children) visit(child);
  };
  visit(body);
  for (const [name, froms] of fromCalls) if (!seen.has(name)) for (const from of froms) out.push({ name, type: "", from });
  return out;
}

/**
 * Kotlin `typealias Users = UserRepository`: the alias answers every member of
 * the class it names, which is exactly what a member-less class extending it
 * says — so `users.save()` on a `Users` resolves to `UserRepository.save`.
 * Marked by its `typealias` decorator. A function-type alias names no class.
 */
function typeAliasClass(node: Node): ClassInfo | null {
  const name = node.children.find((c) => c.type === "type_identifier")?.text;
  const target = node.children.find((c) => c.type === "user_type");
  if (!name || !target) return null;
  const vis = node.descendantsOfType("visibility_modifier")[0]?.text;
  return {
    name,
    kind: "class",
    extends: target.text.replace(/\s+/g, ""),
    implements: [],
    decorators: ["typealias"],
    methods: [],
    properties: [],
    isExported: vis !== "private",
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
  };
}

/**
 * The string constants a Java class body declares — `static final String GROUP = "league.example.com";`,
 * an enum's after its constants too, an interface's implicitly — so another file's `Constant.GROUP`
 * can be read.
 */
function stringConstants(body: Node): Record<string, string> | null {
  const out: Record<string, string> = {};
  const literal = (n: Node | null | undefined): string | null => constantString(n);
  const visit = (container: Node): void => {
    for (const member of container.namedChildren) {
      if (member.type === "enum_body_declarations") visit(member);
      // Kotlin: `const val CLUBS = "/api/v2/clubs"` in an object or a companion object.
      else if (member.type === "companion_object") {
        const inner = member.namedChildren.find((c) => c.type === "class_body");
        if (inner) visit(inner);
      } else if (member.type === "property_declaration") {
        const mods = member.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
        if (!/\bconst\b/.test(mods)) continue;
        const { name } = kotlinNameAndType(member);
        const eq = member.children.findIndex((c) => c.type === "=");
        const value = eq >= 0 ? literal(member.children[eq + 1]) : null;
        if (name && value !== null) out[name] = value;
      }
      else if (member.type === "field_declaration" || member.type === "constant_declaration") {
        const mods = member.namedChildren.find((c) => c.type === "modifiers")?.text ?? "";
        if (member.type === "field_declaration" && !(/\bstatic\b/.test(mods) && /\bfinal\b/.test(mods))) continue;
        for (const d of member.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const name = d.childForFieldName("name")?.text;
          const value = literal(d.childForFieldName("value"));
          if (name && value !== null) out[name] = value;
        }
      }
    }
  };
  visit(body);
  return Object.keys(out).length > 0 ? out : null;
}
