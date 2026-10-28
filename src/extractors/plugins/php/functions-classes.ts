import type { Node, Tree } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { callChainText, extractCalls } from "../../shared/call-graph.js";
import { receiverTypeName } from "../../shared/type-parser.js";
import { arrayLiteralAt, extractPhpRequestAccess, requestReceivers, ruleEntries, ruleType } from "./request-access.js";
import { docblockAbove, parseDocblock, phpLocatorType, useAliases, type DocTypes } from "./di.js";
import { extractPhpResponses } from "./responses.js";

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

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {
      if (
        child.type === "class_declaration" ||
        child.type === "interface_declaration" ||
        child.type === "trait_declaration" ||
        child.type === "enum_declaration"
      ) {
        classes.push(this.parseClass(child));
      } else if (child.type === "namespace_definition") {
        const block = child.childForFieldName("body") ?? this.findChildByType(child, "compound_statement");
        if (block) this.collectClasses(block, classes);
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
      localTypes: extractLocalTypes(body, this.fileAliases),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
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
          for (const part of member.namedChildren) {
            if (part.type === "name" || part.type === "qualified_name") impls.push(part.text.replace(/.*\\/, ""));
          }
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
      localTypes: extractLocalTypes(body, this.fileAliases),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    if (!body && node.children.some((c) => c.type === "abstract_modifier")) fn.abstract = true;
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
): LocalType[] {
  if (!body) return [];
  const out: LocalType[] = [];
  const seen = new Set<string>();
  // Initializer calls wait: a type the body states anywhere beats them. Each
  // distinct call is kept (`$t = $v->createText()` / `$t = $v->createTextRun()`);
  // the linker types the local only when their return types agree.
  const fromCalls = new Map<string, Set<string>>();
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
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left") ?? n.child(0);
      const right = n.childForFieldName("right") ?? n.child(n.childCount - 1);
      const name = varName(left);
      if (name && right) {
        const looked = phpLocatorType(right, aliases);
        if (looked) add(name, looked.type, looked.qualifier);
        // `$w = PHPExcel_IOFactory::createWriter(…)` — typed by what the call returns.
        else add(name, "", undefined, callChainText(right, "php") ?? undefined);
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(body);
  for (const [name, froms] of fromCalls) if (!seen.has(name)) for (const from of froms) out.push({ name, type: "", from });
  return out;
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
