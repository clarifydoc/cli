import type { Node, Tree } from "web-tree-sitter";
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

  /** Set per file: does the source contain a CodeIgniter `$this->load->…` call?
   *  Gates the (otherwise per-class, whole-subtree) `collectCiLoadedDeps` scan so
   *  non-CI files — including large vendor trees — skip it entirely. */
  private fileLoadsDeps = false;

  override extractClasses(tree: Tree, sourceText: string): ClassInfo[] {
    // `$this->load->model(...)` / `->library(...)` always contains `->load->`.
    this.fileLoadsDeps = /->\s*load\s*->/.test(sourceText);
    return super.extractClasses(tree, sourceText);
  }

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
      localTypes: extractLocalNewTypes(body),
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

    // CodeIgniter loads models/libraries dynamically (`$this->load->model('x')`),
    // so `$this->x` has no declared type and the call linker can't follow
    // `$this->x_model->method()` — the controller→model edge that carries the
    // whole DB tier into Call Traces. Synthesize a typed property for each loaded
    // dependency (CI's class name is the Ucfirst of the loaded name) so the
    // standard injection map binds it; resolution no-ops when no such class
    // exists, so this is safe for non-CI PHP.
    this.collectCiLoadedDeps(node, properties);

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
      localTypes: extractLocalNewTypes(body),
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

/**
 * Collect `$x = new Type(...)` local bindings in a function body so the symbol
 * linker can resolve `$x->method()` to `Type::method`. PHP controllers here
 * build a client locally (`$connection = new ApiConnection()`) and then call it
 * — without this the call is an unresolved same-file `internal` reference.
 * Skips nested closures (different scope).
 */
function extractLocalNewTypes(body: Node | null): Array<{ name: string; type: string }> {
  if (!body) return [];
  const out: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();
  const walk = (n: Node): void => {
    if (
      n.type === "anonymous_function_creation_expression" ||
      n.type === "arrow_function" ||
      n.type === "function_definition" ||
      n.type === "method_declaration"
    ) {
      return; // don't descend into a nested scope
    }
    if (n.type === "assignment_expression") {
      const left = n.childForFieldName("left") ?? n.child(0);
      const right = n.childForFieldName("right") ?? n.child(n.childCount - 1);
      if (left?.type === "variable_name" && right?.type === "object_creation_expression") {
        const varName = left.childForFieldName("name")?.text
          ?? left.children.find((c) => c.type === "name")?.text;
        const typeNode = right.children.find((c) => c.type === "name" || c.type === "qualified_name");
        const typeName = typeNode?.text.replace(/.*\\/, ""); // strip namespace
        if (varName && typeName && !seen.has(varName)) {
          seen.add(varName);
          out.push({ name: varName, type: typeName });
        }
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(body);
  return out;
}
