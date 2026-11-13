import type { Node, Tree } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { callChainText, extractCalls } from "../../shared/call-graph.js";
import { receiverTypeName } from "../../shared/type-parser.js";
import { arrayLiteralAt, extractPhpRequestAccess, requestReceivers, ruleEntries, ruleType } from "./request-access.js";
import { docblockAbove, parseDocblock, phpLocatorType, useAliases, type DocTypes } from "./di.js";
import { extractPhpResponses } from "./responses.js";
import { phpCollectionElement } from "./collection-element.js";
import { extractPhpValueFlow } from "./value-flow.js";
import { facadeProxyOf } from "./facades.js";

/** A parameter that can receive a function value: untyped, or typed (also in a union) as one a callable travels as. */
const CALLABLE_TYPE = /^\??(?:callable|Closure|array|string|iterable|mixed|object)$/i;
function mayHoldCallable(p: ParamInfo): boolean {
  return !p.type || p.type.split("|").some((t) => CALLABLE_TYPE.test(t.trim().replace(/^\\/, "")));
}

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/**
 * PHP tree-sitter extractor.
 *
 * Recognises:
 *   - top-level `function_definition`
 *   - `class_declaration`, `interface_declaration`, `trait_declaration`, `enum_declaration`
 *   - PHP 8 `#[Attribute(args)]` lists (mapped onto `decorators`, full text)
 *   - PHP 8 constructor property promotion (`__construct(private Foo $bar)`) —
 *     as a parameter of the constructor AND as a property of the class
 *   - return-type `optional_type`, `named_type`, `primitive_type`, `union_type`
 *   - what a handler reads from `$request` (`FunctionInfo.requestAccess`)
 *   - classes inside a braced `namespace X { … }` block
 *
 * Property types keep their nullability: a `?Address` property is stored as
 * `"?Address"` and a `Foo|null` union as written, so the request-schema
 * hooks can tell optional from required. Parameter and return types are
 * normalized without the `?` as before (the call linker keys on the bare
 * class name).
 */
export class PhpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["php"];

  /** Set per file: does the source contain a CodeIgniter `$this->load->…` call?
   *  Gates the (otherwise per-class, whole-subtree) `collectCiLoadedDeps` scan so
   *  non-CI files — including large vendor trees — skip it entirely. */
  private fileLoadsDeps = false;
  /** Set per file: any `request` token at all? Gates the per-method body scan for `requestAccess`. */
  private fileUsesRequest = false;
  /** Set per file: any JSON answer or API resource at all? Gates the per-method `responses` scan. */
  private fileMayRespond = false;
  /** Set per file: `use X as Y` aliases, so `Y::class` in a container lookup names X. */
  private fileAliases: ReadonlyMap<string, string> = new Map();

  override extractFunctions(tree: Tree, sourceText: string): FunctionInfo[] {
    this.fileUsesRequest = /request/i.test(sourceText);
    this.fileMayRespond = /->\s*json\s*\(|JsonResponse|Resource\b|noContent/.test(sourceText);
    this.fileAliases = / as /.test(sourceText) ? useAliases(tree) : new Map();
    return super.extractFunctions(tree, sourceText);
  }

  override extractClasses(tree: Tree, sourceText: string): ClassInfo[] {
    // `$this->load->model(...)` / `->library(...)` always contains `->load->`.
    this.fileLoadsDeps = /->\s*load\s*->/.test(sourceText);
    this.fileUsesRequest = /request/i.test(sourceText);
    this.fileMayRespond = /->\s*json\s*\(|JsonResponse|Resource\b|noContent/.test(sourceText);
    this.fileAliases = / as /.test(sourceText) ? useAliases(tree) : new Map();
    return super.extractClasses(tree, sourceText);
  }

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.children) {
      if (child.type === "function_definition") {
        functions.push(this.parseFunction(child));
      } else if (child.type === "namespace_definition") {
        // `namespace X { … }` — the braced form nests declarations one level down.
        const block = child.childForFieldName("body") ?? this.findChildByType(child, "compound_statement");
        if (block) this.collectFunctions(block, functions);
      } else if (child.type === "if_statement") {
        for (const block of conditionalBlocks(child)) this.collectFunctions(block, functions);
      }
    }
  }

  /**
   * The namespace the declarations being read sit in, set only for a file that opens more than one
   * (`namespace A { … } namespace B { … }`, or `namespace A;` then `namespace B;`): each of its classes then
   * carries its own `ClassInfo.namespace`, which `declaredNamespace` (the first one) cannot say. A file with one
   * namespace states it once, on the file.
   */
  private classNamespace: string | undefined;
  private multiNamespace = false;

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    if (node.type === "program") {
      this.classNamespace = undefined;
      this.multiNamespace = node.namedChildren.filter((c) => c.type === "namespace_definition").length > 1;
    }
    for (const child of node.children) {
      if (
        child.type === "class_declaration" ||
        child.type === "interface_declaration" ||
        child.type === "trait_declaration" ||
        child.type === "enum_declaration"
      ) {
        const cls = this.parseClass(child);
        if (this.multiNamespace && this.classNamespace) cls.namespace = this.classNamespace;
        classes.push(cls);
      } else if (child.type === "namespace_definition") {
        const name = child.childForFieldName("name")?.text ?? child.namedChildren.find((c) => c.type === "namespace_name")?.text;
        const block = child.childForFieldName("body") ?? this.findChildByType(child, "compound_statement");
        if (block) {
          const outer = this.classNamespace;
          this.classNamespace = name;
          this.collectClasses(block, classes);
          this.classNamespace = outer;
        } else {
          // `namespace A;` holds the declarations that follow, up to the next `namespace`.
          this.classNamespace = name;
        }
      } else if (child.type === "if_statement") {
        for (const block of conditionalBlocks(child)) this.collectClasses(block, classes);
      }
    }
    // `return new class extends Migration { … }`, `new class implements Signer { … }`: an
    // anonymous class's methods are code like any other, named as PHP names the class.
    if (node.type === "program") {
      for (const anon of node.descendantsOfType("anonymous_class")) {
        if (anon) classes.push({ ...this.parseClass(anon), name: "class@anonymous" });
      }
    }
  }

  private parseFunction(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const doc = docTypesAbove(node);
    const params = this.parseParams(node.childForFieldName("parameters"), doc);
    // A native return type wins; a docblock `@return T` types an untyped one.
    const returnType = this.parseReturnType(node) ?? doc?.returnType ?? null;
    const body = node.childForFieldName("body");
    const fn: FunctionInfo = {
      name,
      params,
      returnType,
      isAsync: false,
      isExported: true,
      decorators: this.parseAttributes(node),
      calls: extractCalls(body, "php"),
      localTypes: extractLocalTypes(body, this.fileAliases, params, doc),
      ...docCollectionReturn(this.parseReturnType(node), doc),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    const valueFlow = extractPhpValueFlow(body, params.filter(mayHoldCallable).map((p) => p.name));
    if (valueFlow) fn.valueFlow = valueFlow;
    this.attachRequestAccess(fn, body);
    if (body && this.fileMayRespond) {
      const responses = extractPhpResponses(body.text);
      if (responses.length > 0) fn.responses = responses;
    }
    return fn;
  }

  private parseClass(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const kind = node.type === "interface_declaration" ? "interface" : "class";

    let extendsName: string | null = null;
    const impls: string[] = [];
    const mixins: NonNullable<ClassInfo["mixins"]> = [];

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

    let ctorNode: Node | null = null;
    if (body) {
      for (const member of body.children) {
        if (member.type === "method_declaration") {
          const method = this.parseMethod(member);
          methods.push(method);
          if (method.name === "__construct") {
            this.collectPromotedProperties(member, properties);
            ctorNode = member;
          }
        } else if (member.type === "property_declaration") {
          this.collectProperties(member, properties, docTypesAbove(member));
        } else if (member.type === "use_declaration") {
          // `use HasRoles, Notifiable;` — a trait's methods are the class's own,
          // recorded as supertypes the way Ruby records an `include`.
          const declared: string[] = [];
          for (const part of member.namedChildren) {
            if (part.type !== "name" && part.type !== "qualified_name") continue;
            const trait = part.text.replace(/.*\\/, "");
            declared.push(trait);
            impls.push(trait);
            // A mixed-in trait is a member source the way `extends` is: the class's instances reach its methods.
            if (!mixins.some((m) => m.name === trait)) mixins.push({ name: trait, kind: "include" });
          }
          const clauses = member.namedChildren.find((part) => part.type === "use_list");
          if (clauses) applyTraitConflictClauses(clauses, mixins, declared);
        }
      }
    }
    // Untyped dependencies: a class docblock's `@property Repo $repo` (Laravel
    // IDE helpers, CodeIgniter `@property Users_model $users_model`), and what
    // the constructor stores (`$this->repo = $repo` from a typed parameter,
    // `= new Repo`, `= app(Repo::class)`).
    this.collectDocblockProperties(docTypesAbove(node), properties);
    const ctor = methods.find((m) => m.name === "__construct");
    if (ctor && ctorNode) this.collectConstructorAssignments(ctorNode, ctor, properties);
    markContainerInjectedParams(name, extendsName, methods);

    // CodeIgniter loads models/libraries dynamically (`$this->load->model('x')`),
    // so `$this->x` has no declared type and the call linker can't follow
    // `$this->x_model->method()` — the controller→model edge that carries the
    // whole DB tier into Call Traces. Synthesize a typed property for each loaded
    // dependency (CI's class name is the Ucfirst of the loaded name) so the
    // standard injection map binds it; resolution no-ops when no such class
    // exists, so this is safe for non-CI PHP.
    this.collectCiLoadedDeps(node, properties);
    this.collectFormRequestFields(extendsName, methods, body, properties);
    const staticProxyOf = kind === "class" ? facadeProxyOf(node, extendsName, this.fileAliases) : undefined;

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
      ...(node.children.some((c) => c.type === "abstract_modifier") ? { abstract: true as const } : {}),
      ...(mixins.length > 0 ? { mixins } : {}),
      ...(staticProxyOf ? { staticProxyOf } : {}),
    };
  }

  private parseMethod(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const doc = docTypesAbove(node);
    const params = this.parseParams(node.childForFieldName("parameters"), doc);
    // A native return type wins; a docblock `@return T` types an untyped one.
    const returnType = this.parseReturnType(node) ?? doc?.returnType ?? null;
    const body = node.childForFieldName("body");
    const fn: FunctionInfo = {
      name,
      params,
      returnType,
      isAsync: false,
      isExported: this.isPublicMember(node),
      decorators: this.parseAttributes(node),
      calls: extractCalls(body, "php"),
      localTypes: extractLocalTypes(body, this.fileAliases, params, doc),
      ...docCollectionReturn(this.parseReturnType(node), doc),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    if (!body && node.children.some((c) => c.type === "abstract_modifier")) fn.abstract = true;
    const valueFlow = extractPhpValueFlow(body, params.filter(mayHoldCallable).map((p) => p.name));
    if (valueFlow) fn.valueFlow = valueFlow;
    this.attachRequestAccess(fn, body);
    if (body && this.fileMayRespond) {
      const responses = extractPhpResponses(body.text);
      if (responses.length > 0) fn.responses = responses;
    }
    return fn;
  }

  /**
   * Record what a handler reads from its request object. Gated on the
   * signature — only a function that receives a `$request` (or types one)
   * has anything to read — and on the file containing `request` at all, so
   * the body text (a WASM crossing) is fetched only where it can pay off.
   */
  private attachRequestAccess(fn: FunctionInfo, body: Node | null): void {
    if (!body || !this.fileUsesRequest) return;
    const receivers = requestReceivers(fn.params);
    const text = body.text;
    if (receivers.length === 0 && !text.includes("request(")) return;
    const access = extractPhpRequestAccess(text, receivers);
    if (access.length > 0) fn.requestAccess = access;
  }

  /**
   * Walk `formal_parameters`. Handles:
   *   - `simple_parameter` — `Type $name = default`
   *   - `property_promotion_parameter` — `private Type $name` (PHP 8)
   *   - `variadic_parameter` — `...$args`
   */
  private parseParams(paramsNode: Node | null, doc?: DocTypes): ParamInfo[] {
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
        // A native type wins; a docblock `@param T $name` types an untyped one.
        const typeText = this.parseParamType(p) ?? doc?.named.get(pName) ?? null;
        const defaultNode = p.childForFieldName("default_value");
        const param: ParamInfo = {
          name: pName,
          type: typeText,
          defaultValue: defaultNode?.text ?? null,
        };
        const qualifier = injectionQualifier(this.parseAttributes(p));
        if (qualifier) param.qualifier = qualifier;
        if (p.type === "variadic_parameter") param.variadic = true;
        params.push(param);
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
    // Strip nullable `?`, leading namespace separator, and namespace qualifier
    // — per union/intersection member, so `\App\A|null` stays `A|null`.
    return n.text
      .replace(/^\?/, "")
      .split(/([|&])/)
      .map((part) => (part === "|" || part === "&" ? part : part.replace(/^\\/, "").replace(/.*\\/, "").trim()))
      .join("");
  }

  /**
   * A property's type keeps its nullability — `?Address` stays `"?Address"`
   * (a `Foo|null` union already survives `normalizeType`). Parameters and
   * return types drop the `?` because the call linker keys on the bare name;
   * a property's type is read by the request-schema hooks, which need to know
   * whether the field may be omitted.
   */
  private propertyType(n: Node): string {
    const bare = this.normalizeType(n);
    return n.type === "optional_type" ? "?" + bare : bare;
  }

  /**
   * Walk a `property_declaration` and append every declared field. A typed,
   * non-nullable property with no initializer is `isRequired`: PHP leaves it
   * uninitialized, so a request that builds the object must supply it — the
   * same "must be set" that C# 11's `required` spells out.
   */
  private collectProperties(node: Node, out: PropertyInfo[], doc?: DocTypes): void {
    let visibility: PropertyInfo["visibility"] = "public";
    let isStatic = false;
    let isReadonly = false;
    let typeText: string | null = null;
    const decorators = this.parseAttributes(node);
    const qualifier = injectionQualifier(decorators);

    for (const c of node.children) {
      if (c.type === "visibility_modifier") {
        const v = c.text.toLowerCase();
        if (v === "private" || v === "protected" || v === "public") visibility = v;
      } else if (c.type === "static_modifier") {
        isStatic = true;
      } else if (c.type === "readonly_modifier") {
        isReadonly = true;
      } else if (this.isTypeNode(c)) {
        typeText = this.propertyType(c);
      } else if (c.type === "property_element") {
        const varNode = this.findChildByType(c, "variable_name");
        const nameNode = varNode ? this.findChildByType(varNode, "name") : null;
        const name = nameNode?.text ?? varNode?.text.replace(/^\$/, "") ?? null;
        if (name) {
          const hasDefault = !!c.childForFieldName("default_value") || c.namedChildren.some((n) => n.type !== "variable_name");
          // `/** @var Repo */ private $repo;` — the docblock types an untyped property.
          const docType = typeText ? null : doc?.named.get(name) ?? doc?.varType ?? null;
          const prop: PropertyInfo = { name, type: typeText ?? docType, visibility, isStatic, isReadonly };
          if (decorators.length > 0) prop.decorators = decorators;
          if (qualifier) prop.qualifier = qualifier;
          if (typeText && !isNullableType(typeText) && !hasDefault) prop.isRequired = true;
          out.push(prop);
        }
      }
    }
  }

  /**
   * Object-typed `@property T $name` tags of a class docblock, for properties
   * the class does not declare. Scalars are left out: they type nothing the
   * linker follows, and Eloquent IDE helpers list every column.
   */
  private collectDocblockProperties(doc: DocTypes | undefined, out: PropertyInfo[]): void {
    if (!doc || doc.properties.size === 0) return;
    const declared = new Set(out.map((p) => p.name));
    for (const [name, type] of doc.properties) {
      if (declared.has(name) || !receiverTypeName(type, "php")) continue;
      out.push({ name, type, visibility: "public", isStatic: false, isReadonly: false });
    }
  }

  /**
   * Type the properties a constructor fills: `$this->repo = $repo` takes the
   * (native or docblock) type of parameter `$repo`; `= new Repo(...)` and a
   * container lookup (`= app(Repo::class)`, `= $container->get(Repo::class)`)
   * take the constructed/looked-up class. Only an UNTYPED property is typed
   * (a declared type wins), and a property the class never declares is added
   * — pre-8.2 PHP creates it on assignment.
   */
  private collectConstructorAssignments(ctorNode: Node, ctor: FunctionInfo, out: PropertyInfo[]): void {
    const body = ctorNode.childForFieldName("body");
    if (!body || !body.text.includes("$this->")) return;
    const byName = new Map(out.map((p) => [p.name, p]));
    const params = new Map(ctor.params.map((p) => [p.name, p]));
    for (const stmt of body.namedChildren) {
      const assign = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
      if (assign?.type !== "assignment_expression") continue;
      const left = assign.childForFieldName("left");
      const right = assign.childForFieldName("right");
      if (left?.type !== "member_access_expression" || left.childForFieldName("object")?.text !== "$this" || !right) continue;
      const name = left.childForFieldName("name")?.text;
      if (!name) continue;
      let type: string | null = null;
      let qualifier: string | undefined;
      if (right.type === "variable_name") {
        const param = params.get(right.text.replace(/^\$/, ""));
        type = param?.type ?? null;
        qualifier = param?.qualifier;
      } else {
        const looked = phpLocatorType(right, this.fileAliases);
        if (looked) {
          type = looked.type || null;
          qualifier = looked.qualifier;
        }
      }
      if (!type && !qualifier) continue;
      const existing = byName.get(name);
      if (existing) {
        if (existing.type) continue;
        existing.type = type;
        if (qualifier && !existing.qualifier) existing.qualifier = qualifier;
      } else {
        const prop: PropertyInfo = { name, type, visibility: null, isStatic: false, isReadonly: false };
        if (qualifier) prop.qualifier = qualifier;
        out.push(prop);
        byName.set(name, prop);
      }
    }
  }

  /**
   * PHP 8 constructor promotion: `__construct(public readonly string $email)`
   * declares a property. Same shape as `collectProperties`; the visibility is
   * mandatory here (it is what makes the parameter a promotion).
   */
  private collectPromotedProperties(ctor: Node, out: PropertyInfo[]): void {
    const params = ctor.childForFieldName("parameters");
    if (!params) return;
    for (const p of params.children) {
      if (p.type !== "property_promotion_parameter") continue;
      const varNode = this.findChildByType(p, "variable_name");
      const nameNode = varNode ? this.findChildByType(varNode, "name") : null;
      const name = nameNode?.text ?? varNode?.text.replace(/^\$/, "") ?? null;
      if (!name) continue;
      let visibility: PropertyInfo["visibility"] = "public";
      let isReadonly = false;
      let typeText: string | null = null;
      for (const c of p.children) {
        if (c.type === "visibility_modifier") {
          const v = c.text.toLowerCase();
          if (v === "private" || v === "protected" || v === "public") visibility = v;
        } else if (c.type === "readonly_modifier") {
          isReadonly = true;
        } else if (this.isTypeNode(c)) {
          typeText = this.propertyType(c);
        }
      }
      const hasDefault = !!p.childForFieldName("default_value");
      const prop: PropertyInfo = { name, type: typeText, visibility, isStatic: false, isReadonly };
      const decorators = this.parseAttributes(p);
      if (decorators.length > 0) prop.decorators = decorators;
      const qualifier = injectionQualifier(decorators);
      if (qualifier) prop.qualifier = qualifier;
      if (typeText && !isNullableType(typeText) && !hasDefault) prop.isRequired = true;
      out.push(prop);
    }
  }

  /**
   * A Laravel `FormRequest` declares the request body it validates in
   * `rules()`, not in properties — `'customer_id' => 'required|integer'`.
   * Synthesize one public property per top-level rule key (type from the
   * rule, `isRequired` from `required`, the rule text kept as a `Rule(…)`
   * decorator) so the request-schema pass, which reads `properties`, can
   * flatten a `store(StoreOrderRequest $request)` body like any DTO. Nested
   * keys (`items.*.sku`) describe the `items` array's elements and are
   * skipped — the `items` key itself is what the body carries.
   */
  private collectFormRequestFields(extendsName: string | null, methods: FunctionInfo[], body: Node | null, out: PropertyInfo[]): void {
    if (!body || !extendsName || !/Request$/.test(extendsName)) return;
    if (!methods.some((m) => m.name === "rules")) return;
    const rulesNode = body.children.find(
      (m) => m.type === "method_declaration" && m.childForFieldName("name")?.text === "rules",
    );
    const text = rulesNode?.childForFieldName("body")?.text ?? "";
    const open = text.search(/return\s*\[/);
    if (open < 0) return;
    const seen = new Set(out.map((p) => p.name));
    for (const e of ruleEntries(arrayLiteralAt(text, text.indexOf("[", open)))) {
      if (e.name.includes(".") || e.name.includes("*") || seen.has(e.name)) continue;
      seen.add(e.name);
      const prop: PropertyInfo = {
        name: e.name,
        type: ruleType(e.rules),
        visibility: "public",
        isStatic: false,
        isReadonly: false,
        decorators: [`Rule(${JSON.stringify(e.rules)})`],
      };
      if (/\brequired\b/.test(e.rules)) prop.isRequired = true;
      out.push(prop);
    }
  }

  /**
   * Scan a class body for CodeIgniter `$this->load->model('x')` /
   * `$this->load->library('y')` calls and append a synthetic typed property for
   * each — `$this->customers_model` → `Customers_model`. CI's loaded name maps
   * to its class by Ucfirst of the file basename (a `'sub/foo_model'` path keeps
   * only `foo_model`); an optional second string arg is the object name CI binds
   * the instance to (`$this->load->model('x_model','alias')` → `$this->alias`).
   */
  private collectCiLoadedDeps(classNode: Node, out: PropertyInfo[]): void {
    if (!this.fileLoadsDeps) return; // no `->load->` in this file — skip the walk
    const seen = new Set(out.map((p) => p.name));
    const visit = (n: Node): void => {
      if (n.type === "member_call_expression") {
        const method = n.childForFieldName("name")?.text ?? "";
        const recv = (n.childForFieldName("object")?.text ?? "").replace(/\s+/g, "");
        if ((method === "model" || method === "library") && /\$this->load$/.test(recv)) {
          const args = this.stringArgs(n.childForFieldName("arguments"));
          if (args.length > 0) {
            const baseName = args[0]!.split("/").pop() ?? args[0]!;
            const propName = args[1] && /^[A-Za-z_]\w*$/.test(args[1]) ? args[1]! : baseName;
            const typeName = baseName.charAt(0).toUpperCase() + baseName.slice(1);
            if (propName && /^[A-Za-z_]\w*$/.test(propName) && !seen.has(propName)) {
              seen.add(propName);
              out.push({
                name: propName,
                type: typeName,
                visibility: "public",
                isStatic: false,
                isReadonly: false,
              });
            }
          }
        }
      }
      for (const c of n.children) visit(c);
    };
    visit(classNode);
  }

  /** All literal string arguments of a call's `arguments` node, in order. */
  private stringArgs(argsNode: Node | null): string[] {
    if (!argsNode) return [];
    const out: string[] = [];
    for (const a of argsNode.children) {
      if (a.type !== "argument") continue;
      for (const inner of a.children) {
        if (inner.type === "string") {
          const frag = this.findChildByType(inner, "string_content");
          out.push((frag?.text ?? inner.text).replace(/^['"]|['"]$/g, ""));
          break;
        }
        if (inner.type === "encapsed_string") {
          out.push(inner.text.replace(/^"|"$/g, ""));
          break;
        }
      }
    }
    return out;
  }

  /**
   * Map PHP 8 `#[Attribute(args)]` lists onto our `decorators` field — the
   * full attribute text with its arguments, whitespace collapsed, leading `\`
   * dropped: `IsGranted('ROLE_ADMIN')`, `Route('/x', methods: ['POST'])`,
   * `Assert\NotBlank`. The arguments are where routing, auth and
   * serialization live; the bare name was useless to every consumer that
   * needed them (same convention as the C# and JS decorator helpers).
   */
  private parseAttributes(node: Node): string[] {
    const decorators: string[] = [];
    for (const c of node.children) {
      if (c.type !== "attribute_list") continue;
      for (const group of c.children) {
        if (group.type !== "attribute_group") continue;
        for (const attr of group.children) {
          if (attr.type !== "attribute") continue;
          decorators.push(attr.text.replace(/^\\/, "").replace(/\s+/g, " "));
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

/** `?Foo`, `Foo|null`, `null|Foo`, `mixed` — a property type that admits null. */
function isNullableType(type: string): boolean {
  if (type.startsWith("?")) return true;
  if (type === "mixed") return true;
  return type.split("|").some((m) => m.trim().toLowerCase() === "null");
}

/**
 * Parameters the container resolves although they are not a constructor's:
 * Laravel and Symfony call controller actions with their class-typed
 * parameters resolved from the container (method injection), and Laravel
 * does the same for the `handle()` of jobs, listeners, commands and
 * middleware and for an invokable's `__invoke()`. Marked so container
 * registrations decide them; any other method's parameters are whatever its
 * caller passes.
 */
function markContainerInjectedParams(className: string, extendsName: string | null, methods: FunctionInfo[]): void {
  const controller = /Controller$/.test(className) || /(?:^|\\)(?:Abstract)?Controller$/.test(extendsName ?? "");
  for (const m of methods) {
    if (m.name === "__construct") continue;
    if (!(m.name === "handle" || m.name === "__invoke" || (controller && m.isExported))) continue;
    for (const p of m.params) if (p.type) p.injected = true;
  }
}

/** A native `array` result the docblock states the elements of (`@return Player[]`): kept beside `returnType`. */
function docCollectionReturn(native: string | null, doc: DocTypes | undefined): { declaredReturnType?: string } {
  if (!native || !/^\??(?:array|iterable)$/i.test(native) || !doc?.returnType || !phpCollectionElement(doc.returnType)) return {};
  return { declaredReturnType: doc.returnType };
}

/** The docblock above a declaration, parsed (undefined when there is none). */
function docTypesAbove(node: Node): DocTypes | undefined {
  const text = docblockAbove(node);
  return text ? parseDocblock(text) : undefined;
}

/**
 * The DI token an attribute names on an injection point: Symfony
 * `#[Target('name')]` (a named autowiring alias) and `#[Autowire(service:
 * 'id')]` / `#[Autowire('@id')]`.
 */
function injectionQualifier(decorators: string[]): string | undefined {
  for (const d of decorators) {
    const target = /^(?:[\w\\]+\\)?Target\(\s*['"]([^'"]+)['"]/.exec(d);
    if (target) return target[1];
    const autowire = /^(?:[\w\\]+\\)?Autowire\((?:[^)]*\bservice\s*:\s*)?['"]@?([^'"]+)['"]/.exec(d);
    if (autowire && /\bservice\s*:|['"]@/.test(d)) return autowire[1];
  }
  return undefined;
}

/** Statements and clauses that hold a block of their own: a write inside one is not in the straight line after it. */
const PHP_BLOCKS: ReadonlySet<string> = new Set([
  "compound_statement", "colon_block", "if_statement", "else_clause", "else_if_clause", "for_statement", "foreach_statement",
  "while_statement", "do_statement", "switch_block", "case_statement", "default_statement", "try_statement", "catch_clause",
  "finally_clause", "match_block", "match_conditional_expression", "match_default_expression", "conditional_expression",
]);
/** Declared parameter types that name no class. */
const PHP_SCALAR_TYPES: ReadonlySet<string> = new Set(["int", "float", "string", "bool", "array", "iterable", "callable", "object", "mixed", "null", "void", "self", "static", "parent", "false", "true", "never"]);

const PHP_LOOPS: ReadonlySet<string> = new Set(["for_statement", "foreach_statement", "while_statement", "do_statement"]);

/** Whether the text binds `$name` other than by a plain assignment: a `foreach` target, a `catch` variable, `global`/`static`, a `list()`/`[...]` target, a reference. */
function rebinds(text: string, name: string): boolean {
  const v = `\\$${name}\\b`;
  const forms = [
    `\\bas\\s+(?:&?\\$\\w+\\s*=>\\s*)?&?${v}`,
    `\\bcatch\\s*\\([^)]*${v}`,
    `\\b(?:global|static)\\s+[^;]*${v}`,
    `\\b(?:list\\s*\\(|\\[)[^\\]=;)]*${v}[^\\]=;)]*[\\])]\\s*=(?!=)`,
    `&\\s*${v}`,
  ];
  return forms.some((f) => new RegExp(f).test(text));
}

/**
 * Locals whose type the body states, so the symbol linker can resolve
 * `$x->method()` to `Type::method`:
 *   `$x = new Type(...)`                — PHP controllers build a client locally
 *   `$x = app(Type::class)`, `resolve()`, `->make()`, `->get(Type::class)`,
 *   `App::make()`                       — a container lookup (string ids give a qualifier)
 *   `/** @var Type $x *\/` above a statement, or `/** @var Type *\/` above `$x = …`
 * The first binding of a name wins. Skips nested closures (different scope).
 */
function extractLocalTypes(
  body: Node | null,
  aliases: ReadonlyMap<string, string>,
  params: readonly ParamInfo[] = [],
  doc?: DocTypes,
): LocalType[] {
  if (!body) return [];
  const out: LocalType[] = [];
  const seen = new Set<string>();
  // Initializer calls wait: a type the body states anywhere beats them. Each
  // distinct call is kept (`$t = $v->createText()` / `$t = $v->createTextRun()`);
  // the linker types the local only when their return types agree.
  const fromCalls = new Map<string, Set<string>>();
  // `$q = $p`: the variable another one was assigned from; a name also assigned anything else is no alias.
  const aliasFroms = new Map<string, Set<string>>();
  const otherAssigned = new Set<string>();
  // Flow order: each name's writes in text order (a stated type, or null), and where each alias was written, so an
  // alias of a name written more than once takes the write before it when that one states a type.
  const writes = new Map<string, Array<{ type: string | null; block: number; pos: number }>>();
  // `loopEnds`: where each loop the alias sits in ends, to tell a head written again later in the same loop.
  const aliasSites = new Map<string, Array<{ head: string; type: string | null; at: number; loopEnds: number[] }>>();
  const blockOf = (n: Node): number => {
    for (let p = n.parent; p; p = p.parent) if (p.id === body.id || PHP_BLOCKS.has(p.type)) return p.id;
    return body.id;
  };
  const write = (n: Node, name: string, type: string | null): void => {
    (writes.get(name) ?? writes.set(name, []).get(name)!).push({ type, block: blockOf(n), pos: n.startIndex });
  };
  // A parameter is the head's first write: bound on entry, in the body's own block, typed by its declaration.
  for (const p of params) {
    // A variadic parameter is an array in the body, whatever its element type says.
    const t = p.variadic ? undefined : /^\??\\?([A-Za-z_][\w\\]*)$/.exec(p.type ?? "")?.[1];
    writes.set(p.name, [{ type: t && !PHP_SCALAR_TYPES.has(t.toLowerCase()) ? t : null, block: body.id, pos: -1 }]);
  }
  const add = (name: string | undefined, type: string, qualifier?: string, from?: string): void => {
    if (!name || seen.has(name)) return;
    if (!type && !qualifier) {
      if (from) fromCalls.set(name, (fromCalls.get(name) ?? new Set()).add(from));
      return;
    }
    seen.add(name);
    const local: LocalType = { name, type };
    if (qualifier) local.qualifier = qualifier;
    out.push(local);
  };
  const varName = (n: Node | null | undefined): string | undefined =>
    n?.type === "variable_name"
      ? n.childForFieldName("name")?.text ?? n.children.find((c) => c.type === "name")?.text
      : undefined;
  // `foreach (<source> as [$key =>] $value)`: the value is the element of what the source is, settled once every
  // typed local is known.
  const loops: Array<{ name: string; source: Node }> = [];
  const loopNames = new Set<string>();
  const walk = (n: Node): void => {
    if (
      n.type === "anonymous_function" || // tree-sitter-php ≥0.23 name
      n.type === "anonymous_function_creation_expression" || // pre-rename
      n.type === "arrow_function" ||
      n.type === "function_definition" ||
      n.type === "method_declaration"
    ) {
      return; // don't descend into a nested scope
    }
    if (n.type === "comment" && n.text.startsWith("/**") && n.text.includes("@var")) {
      // `/** @var Repo $repo */` names its variable; a bare `/** @var Repo */`
      // types the assignment that follows.
      const doc = parseDocblock(n.text);
      for (const [name, type] of doc.named) add(name, type);
      if (doc.varType) {
        const next = n.nextNamedSibling;
        const assign = next?.type === "expression_statement" ? next.namedChildren[0] : null;
        if (assign?.type === "assignment_expression") add(varName(assign.childForFieldName("left")), doc.varType);
      }
    }
    if (n.type === "foreach_statement") {
      const [source, target] = n.namedChildren;
      const value = target?.type === "pair" ? target.namedChildren[1] : target;
      const bound = value?.type === "by_ref" ? value.namedChildren[0] : value;
      // Any other binding the head makes (a destructuring list, a key) shadows an earlier typed one.
      for (const v of target?.type === "pair" ? [target.namedChildren[0]] : []) if (varName(v)) loopNames.add(varName(v)!);
      if (bound?.type === "variable_name" && source && varName(bound)) loops.push({ name: varName(bound)!, source });
      else if (target) for (const v of target.descendantsOfType("variable_name")) if (varName(v)) loopNames.add(varName(v)!);
    }
    if (n.type === "augmented_assignment_expression") {
      const target = varName(n.childForFieldName("left") ?? n.child(0));
      if (target) write(n, target, null);
    }
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left") ?? n.child(0);
      const right = n.childForFieldName("right") ?? n.child(n.childCount - 1);
      const name = varName(left);
      if (name && right) {
        const aliasHead = varName(right);
        const looked = phpLocatorType(right, aliases);
        if (aliasHead && aliasHead !== "this" && aliasHead !== name && left?.type === "variable_name") {
          (aliasFroms.get(name) ?? aliasFroms.set(name, new Set()).get(name)!).add(aliasHead);
          const headWrites = writes.get(aliasHead);
          const last = headWrites?.[headWrites.length - 1];
          let open = false;
          const loopEnds: number[] = [];
          for (let p: Node | null = n.parent; p; p = p.parent) {
            if (last && p.id === last.block) open = true;
            if (PHP_LOOPS.has(p.type)) loopEnds.push(p.endIndex);
            if (p.id === body.id) break;
          }
          (aliasSites.get(name) ?? aliasSites.set(name, []).get(name)!).push({ head: aliasHead, type: last && open ? last.type : null, at: n.startIndex, loopEnds });
          write(n, name, null);
        } else {
          otherAssigned.add(name);
          write(n, name, looked && looked.type && !looked.qualifier ? looked.type : null);
        }
        if (looked) add(name, looked.type, looked.qualifier);
        // `$w = PHPExcel_IOFactory::createWriter(…)` — typed by what the call returns.
        else add(name, "", undefined, callChainText(right, "php") ?? undefined);
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(body);
  // A loop variable over a typed array (a parameter or a `@var` local) takes its element; over a call or a property
  // it is the linker's to read off the declaration. Any other binding of the name leaves it untyped.
  const typedAs = (name: string): string | null => {
    const local = out.filter((l) => l.name === name && l.type);
    if (local.length === 1) return local[0]!.type;
    if (local.length > 0) return null;
    const param = params.find((p) => p.name === name)?.type ?? null;
    // A native `array` says nothing of its elements; the docblock's `@param Player[] $players` does.
    return param && /^\??(?:array|iterable)$/i.test(param) ? doc?.named.get(name) ?? param : param;
  };
  const elements: LocalType[] = [];
  for (const { name, source } of loops) {
    if (loopNames.has(name) || seen.has(name) || fromCalls.has(name) || params.some((p) => p.name === name)) continue;
    let from: string | null = null;
    let elementType: string | null = null;
    if (source.type === "variable_name") {
      const sourceName = varName(source);
      const written = sourceName ? typedAs(sourceName) : null;
      elementType = written ? phpCollectionElement(written) : null;
    } else if (source.type === "member_call_expression" || source.type === "nullsafe_member_call_expression" || source.type === "scoped_call_expression") {
      from = callChainText(source, "php");
    } else if (source.type === "member_access_expression" || source.type === "nullsafe_member_access_expression") {
      from = propertyChainText(source);
    }
    if (elementType) elements.push({ name, type: elementType });
    else if (from) elements.push({ name, type: "", from, element: true });
  }
  // Two loops binding one name to different types leave it untyped; unresolved ones are the linker's to agree on.
  const byName = new Map<string, LocalType[]>();
  for (const e of elements) byName.set(e.name, [...(byName.get(e.name) ?? []), e]);
  for (const list of byName.values()) {
    const typed = list.filter((e) => e.type);
    if (typed.length === 0) out.push(...list);
    else if (typed.length === list.length && new Set(typed.map((e) => e.type)).size === 1) out.push(typed[0]!);
  }
  for (const [name, froms] of fromCalls) if (!seen.has(name)) for (const from of froms) out.push({ name, type: "", from });
  for (const [name, heads] of aliasFroms) {
    if (heads.size === 1 && !seen.has(name) && !fromCalls.has(name) && !otherAssigned.has(name) && !rebinds(body.text, name)) {
      const head = [...heads][0]!;
      const sites = aliasSites.get(name) ?? [];
      // A head written more than once: the write before the alias, when it states a type (not in a loop, not
      // rebound by a `foreach`, `catch`, `list()` or reference).
      if (sites.length === 1 && (writes.get(head)?.length ?? 0) >= 2) {
        const site = sites[0]!;
        // In a loop, the back edge also brings a write of the head after the alias in that body: typed only when it
        // states the same type.
        const later = (writes.get(head) ?? []).some((w) => w.pos > site.at && site.loopEnds.some((end) => w.pos < end) && w.type !== site.type);
        if (site.type && !later && !rebinds(body.text, head)) out.push({ name, type: site.type });
        continue;
      }
      out.push({ name, type: "", aliasOf: head });
    }
  }
  return out;
}

/** `$this->players`, `$club->roster->players`: a property chain off a variable, spelled for `localTypes[].from`. */
function propertyChainText(node: Node): string | null {
  const parts: string[] = [];
  let cur: Node | null = node;
  while (cur?.type === "member_access_expression" || cur?.type === "nullsafe_member_access_expression") {
    const name = cur.childForFieldName("name");
    if (name?.type !== "name") return null;
    parts.unshift(name.text);
    cur = cur.childForFieldName("object");
  }
  if (cur?.type !== "variable_name") return null;
  parts.unshift(cur.text.replace(/^\$/, ""));
  return parts.length >= 2 ? parts.join(".") : null;
}

/**
 * Typed locals of a page's top-level statements (`$repo = new ClubRepo();`
 * above the markup that loops over `$repo->all()`), for the file's `<setup>`.
 * Functions and methods are their own scopes and never see them.
 */
export function phpTopLevelLocalTypes(tree: Tree, sourceText: string): LocalType[] {
  return extractLocalTypes(tree.rootNode, / as /.test(sourceText) ? useAliases(tree) : new Map());
}

/**
 * The blocks of a top-level `if` that declares conditionally — the helper
 * idiom `if (!function_exists('money')) { function money() { … } }` and
 * `if (!class_exists('Club')) { class Club { … } }`: the then-block, each
 * `elseif`/`else` block, braced or `if (): … endif;`. What they declare is
 * declared at file scope once the branch runs.
 */
function conditionalBlocks(node: Node): Node[] {
  const out: Node[] = [];
  for (const c of node.children) {
    if (c.type === "compound_statement" || c.type === "colon_block") out.push(c);
    else if (c.type === "else_clause" || c.type === "else_if_clause") out.push(...conditionalBlocks(c));
  }
  return out;
}

const bareTrait = (written: string): string => written.trim().replace(/.*\\/, "");

/**
 * The conflict clauses of `use A, B { A::stamp insteadof B; B::stamp as logStamp; stamp as protected; }`
 * onto the mixins the class's `use` recorded: `insteadof` takes the method from each trait it names
 * as the loser, `as name` gives the class another name for a trait's method (a visibility-only
 * `as protected` adds nothing a lookup needs). Read off each clause's text — the grammar wraps a
 * comma list after `insteadof` in an ERROR node.
 */
function applyTraitConflictClauses(list: Node, mixins: NonNullable<ClassInfo["mixins"]>, declared: string[]): void {
  const mixinOf = (written: string) => mixins.find((m) => m.name === bareTrait(written));
  // Statement by statement from the list's text (comments dropped): the grammar splits a comma list
  // after `insteadof` across an ERROR node, so the clause nodes alone lose its later traits.
  const body = list.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*|#.*/g, "").replace(/^\s*\{|\}\s*$/g, "");
  for (const raw of body.split(";")) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.includes(" insteadof ")) {
      const m = /^[\w\\]+::(\w+) insteadof (.+)$/.exec(text);
      if (!m) continue;
      for (const loser of m[2]!.split(",")) {
        const mixin = mixinOf(loser);
        if (mixin && !(mixin.excludes ??= []).includes(m[1]!)) mixin.excludes.push(m[1]!);
      }
    } else {
      const m = /^(?:([\w\\]+)::)?(\w+) as (?:(?:public|protected|private) )?(\w+)$/.exec(text);
      if (!m || /^(public|protected|private)$/.test(m[3]!)) continue;
      const targets = m[1] ? [mixinOf(m[1])] : mixins.filter((x) => declared.includes(x.name));
      for (const mixin of targets) if (mixin) (mixin.aliases ??= {})[m[3]!] = m[2]!;
    }
  }
}
