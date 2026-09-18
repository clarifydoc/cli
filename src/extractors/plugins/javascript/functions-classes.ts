import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo } from "../../../types/analysis.js";
import { getVisibility, extractJsDecorators, stripQuotes } from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";
import { foldValue, type ValueExpr } from "../../shared/value-resolver.js";
import { astToValueExpr } from "./value-capture.js";

/**
 * Dynamic `import("./x.vue")` calls inside a function body, surfaced as
 * cross-file call edges so lazy-loaded modules — route targets and components
 * launched via `useDialog().open({ component: import("./dlg.vue") })` — stay
 * reachable in the call/trace graph instead of dead-ending at the loader.
 *
 * Launchers usually wrap the import in a callback (`new Promise((res) => …)`),
 * which `extractCalls` skips as a nested scope, so this descends through
 * anonymous arrows/function-expressions but stops at nested *named* functions
 * and classes (those are linked as their own units). The target resolves to the
 * imported module's default export — for a `.vue` that's the component itself.
 */
function collectDynamicImportCalls(body: Node | null): CallInfo[] {
  if (!body) return [];
  const out: CallInfo[] = [];
  const seen = new Set<string>();

  const walk = (node: Node, isRoot: boolean): void => {
    if (
      !isRoot &&
      (node.type === "function_declaration" ||
        node.type === "generator_function_declaration" ||
        node.type === "class_declaration" ||
        node.type === "class")
    ) {
      return;
    }

    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee && callee.type === "import") {
        const arg = node.childForFieldName("arguments")?.child(1);
        if (arg && arg.type === "string") {
          const source = stripQuotes(arg.text);
          // Project-local specifiers only (relative or path-alias) — a bare
          // package import isn't a project file. Unresolvable ones simply
          // produce no link downstream.
          const local = /^[./]/.test(source) || /^[@~]/.test(source);
          if (local && !seen.has(source)) {
            seen.add(source);
            out.push({
              name: "default",
              kind: "cross-file",
              target: source,
              line: node.startPosition.row + 1,
              confidence: "EXTRACTED",
            });
          }
        }
      }
    }

    for (const child of node.children) walk(child, false);
  };

  walk(body, true);
  return out;
}

/**
 * If a function's return value is an app-relative request URL built from string
 * concatenation / a template literal, derive its parameterized template:
 * path literals verbatim, each parameter referenced in the URL as `{paramName}`,
 * an environment base (`import.meta.env.VITE_X` / `process.env.Y`) dropped, and
 * any other runtime reference (a closure/local variable) as `{}`. Returns
 * undefined for non-URL functions (the result must contain a `/`).
 *
 * Real Vue/React data layers funnel every request through such a helper
 * (`requestUri(endpoint, version)`, `adminUri(subPath)`), so without resolving
 * it the api-call carries no joinable URL. A project-level pass substitutes a
 * call site's literal args into this template.
 *
 * Deliberately shallow: only a top-level `return` (and a one-hop local `const
 * x = <url>; return x`) is followed — a URL assembled inside a branch can't be
 * represented as a single template anyway.
 */
export function extractUrlTemplate(
  body: Node | null,
  paramNames: ReadonlySet<string>,
): string | undefined {
  if (!body) return undefined;

  // Top-level `const/let x = <expr>` bindings, for a `return x` indirection.
  const locals = new Map<string, Node>();
  let returnExpr: Node | null = null;

  if (body.type === "statement_block") {
    for (const stmt of body.namedChildren) {
      if (
        (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") &&
        !returnExpr
      ) {
        for (const decl of stmt.namedChildren) {
          if (decl.type !== "variable_declarator") continue;
          const nm = decl.childForFieldName("name");
          const val = decl.childForFieldName("value");
          if (nm?.type === "identifier" && val) locals.set(nm.text, val);
        }
      } else if (stmt.type === "return_statement") {
        returnExpr = stmt.namedChild(0);
        break;
      }
    }
  } else {
    // Expression-bodied arrow: the body itself is the returned expression.
    returnExpr = body;
  }

  if (!returnExpr) return undefined;

  // Capture the pre-return top-level consts as a function-local scope, then fold
  // the returned expression. `envMode: "collapse"` drops an environment base to
  // "" (the template is app-relative), matching the legacy behavior exactly.
  const scope = new Map<string, ValueExpr>();
  for (const [name, valueNode] of locals) {
    scope.set(name, astToValueExpr(valueNode));
  }
  const { text } = foldValue(astToValueExpr(returnExpr), scope, {
    params: paramNames,
    envMode: "collapse",
  });
  if (text == null || !text.includes("/")) return undefined;
  return text;
}

/**
 * Bare name of a type reference: drops type arguments and trailing whitespace
 * so `Repo<User>` matches the declaration named `Repo`. Keeps dotted names
 * (`React.Component`) intact — that is how the source names the base.
 */
function bareTypeName(text: string): string {
  const cut = text.indexOf("<");
  return (cut === -1 ? text : text.slice(0, cut)).trim();
}

export class JavaScriptExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractJsFunctions(node, functions, false);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractJsClasses(node, classes);
  }

  private extractJsFunctions(
    node: Node,
    functions: FunctionInfo[],
    isExported: boolean,
  ): void {
    for (const child of node.children) {

      if (child.type === "export_statement") {
        this.extractJsFunctions(child, functions, true);
        continue;
      }

      if (
        child.type === "function_declaration" ||
        child.type === "generator_function_declaration"
      ) {
        functions.push(this.parseJsFunction(child, isExported));
        // Descend into the body: NAMED functions nested inside a function are
        // real symbols — a React component's `const onSubmitHandler = async
        // (e) => {…}` is where the click handling (and its api-calls) actually
        // lives. Skipping them dropped the handler AND its body's calls from
        // the graph, so every React click-trace dead-ended at the component.
        const body = child.childForFieldName("body");
        if (body) this.extractJsFunctions(body, functions, false);
      } else if (
        child.type === "lexical_declaration" ||
        child.type === "variable_declaration"
      ) {
        for (const decl of child.children) {
          if (decl.type === "variable_declarator") {
            const name = decl.childForFieldName("name")?.text;
            const value = decl.childForFieldName("value");
            if (
              name &&
              value &&
              (value.type === "arrow_function" ||
                value.type === "function_expression")
            ) {
              functions.push(this.parseJsArrowOrExpr(name, value, isExported));
            }
            // Named bindings can hide anywhere below (an arrow's body, a
            // useEffect callback, a call argument) — keep walking the value.
            if (value) this.extractJsFunctions(value, functions, false);
          }
        }
      } else if (
        child.type === "class_declaration" ||
        child.type === "abstract_class_declaration" ||
        child.type === "class_body"
      ) {
        // Class members are the class extractor's territory.
        continue;
      } else {
        // Generic descent: statements, blocks, JSX, call arguments — anonymous
        // functions are never extracted, but named bindings inside them are.
        this.extractJsFunctions(child, functions, false);
      }
    }
  }

  private parseJsFunction(node: Node, isExported: boolean): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const params = this.extractJsParams(node.childForFieldName("parameters"));
    const returnType = node.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = node.text.startsWith("async ");
    const decorators = this.extractDecorators(node);

    const body = node.childForFieldName("body");
    const urlTemplate = extractUrlTemplate(body, new Set(params.map((p) => p.name)));
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls: [...extractCalls(body, "typescript"), ...collectDynamicImportCalls(body)],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      ...(urlTemplate ? { urlTemplate } : {}),
    };
  }

  private parseJsArrowOrExpr(
    name: string,
    node: Node,
    isExported: boolean,
  ): FunctionInfo {
    // Handle type assertions wrapping the arrow function: `const f = ((): T => {}) as const`
    let funcNode = node;
    if (
      funcNode.type === "as_expression" ||
      funcNode.type === "satisfies_expression" ||
      funcNode.type === "type_assertion"
    ) {
      const inner = funcNode.child(0);
      if (inner && (inner.type === "arrow_function" || inner.type === "function_expression")) {
        funcNode = inner;
      }
    }

    const params = this.extractJsParams(funcNode.childForFieldName("parameters"));
    const returnType = funcNode.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
    const isAsync = funcNode.text.startsWith("async ");

    // Extract decorators from the parent declaration if present
    const declarator = funcNode.parent;
    const declaration = declarator?.parent;
    const decorators =
      declaration ? this.extractDecorators(declaration) : [];

    const body = funcNode.childForFieldName("body") ?? funcNode;
    const urlTemplate = extractUrlTemplate(body, new Set(params.map((p) => p.name)));
    return {
      name,
      params,
      returnType,
      isAsync,
      isExported,
      decorators,
      calls: [...extractCalls(body, "typescript"), ...collectDynamicImportCalls(body)],
      line: funcNode.startPosition.row + 1,
      endLine: funcNode.endPosition.row + 1,
      ...(urlTemplate ? { urlTemplate } : {}),
    };
  }

  private extractJsParams(paramsNode: Node | null): ParamInfo[] {
    if (!paramsNode) return [];
    const params: ParamInfo[] = [];

    for (const child of paramsNode.children) {
      if (
        child.type === "required_parameter" ||
        child.type === "optional_parameter" ||
        child.type === "identifier" ||
        child.type === "rest_pattern"
      ) {
        const name =
          child.childForFieldName("pattern")?.text ??
          child.childForFieldName("name")?.text ??
          child.text;
        const typeNode = child.childForFieldName("type");
        const defaultNode = child.childForFieldName("value");

        params.push({
          name,
          type: typeNode?.text?.replace(/^:\s*/, "") ?? null,
          defaultValue: defaultNode?.text ?? null,
        });
      }
    }
    return params;
  }

  private extractJsClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {
      if (child.type === "export_statement") {
        for (const inner of child.children) {
          this.collectJsClassLike(inner, classes, true);
        }
        continue;
      }
      this.collectJsClassLike(child, classes, false);
    }
  }

  /**
   * A class, an abstract class or a TypeScript interface. Abstract classes and
   * interfaces are first-class here because the symbol linker's interface
   * fan-out (`buildInterfaceImplMap`) resolves a call on an interface-typed
   * receiver to every implementation — machinery that stays dead for TS/JS
   * unless interfaces reach `analysis.classes` with `kind: "interface"`.
   */
  private collectJsClassLike(node: Node, classes: ClassInfo[], isExported: boolean): void {
    if (node.type === "class_declaration" || node.type === "abstract_class_declaration") {
      classes.push(this.parseJsClass(node, isExported));
    } else if (node.type === "interface_declaration") {
      classes.push(this.parseTsInterface(node, isExported));
    }
  }

  /**
   * A TypeScript interface as a ClassInfo: method signatures become methods
   * with no body (so `calls` is empty), property signatures become properties.
   */
  private parseTsInterface(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const extendsList: string[] = [];
    // `interface A extends B, C` is an `extends_type_clause` CHILD holding one
    // `type` field entry per base — unlike a class, which can only have one.
    for (const child of node.children) {
      if (child.type !== "extends_type_clause") continue;
      for (const t of child.namedChildren) {
        const bare = bareTypeName(t.text);
        if (bare) extendsList.push(bare);
      }
    }

    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body");
    if (body) {
      for (const member of body.namedChildren) {
        if (member.type === "method_signature") {
          methods.push({
            name: member.childForFieldName("name")?.text ?? "anonymous",
            params: this.extractJsParams(member.childForFieldName("parameters")),
            returnType: member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null,
            isAsync: false,
            isExported: false,
            decorators: [],
            calls: [],
            line: member.startPosition.row + 1,
            endLine: member.endPosition.row + 1,
          });
        } else if (member.type === "property_signature") {
          properties.push({
            name: member.childForFieldName("name")?.text ?? "unknown",
            type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
            visibility: null,
            isStatic: false,
            isReadonly: member.text.includes("readonly "),
          });
        }
      }
    }

    return {
      name,
      // An interface has no runtime base; the first `extends` keeps the shape
      // other consumers expect, and the rest ride along in `implements` so the
      // impl map can match on either (it inspects both).
      extends: extendsList[0] ?? null,
      implements: extendsList.slice(1),
      decorators: [],
      methods,
      properties,
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind: "interface",
    };
  }

  private parseJsClass(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    // Heritage is a `class_heritage` CHILD, not a field — reading it as a field
    // (`childForFieldName("heritage")`) silently returned null for every class
    // in every TS and JS file, so inheritance was never recorded for the most
    // common language in the corpus. TS spells the inside as
    // `extends_clause` / `implements_clause`; plain JS has a bare expression.
    for (const child of node.children) {
      if (child.type !== "class_heritage") continue;
      for (const clause of child.namedChildren) {
        if (clause.type === "extends_clause") {
          // `value` excludes `type_arguments`, so `extends Base<T>` -> `Base`.
          extendsName = bareTypeName(clause.childForFieldName("value")?.text ?? "") || null;
        } else if (clause.type === "implements_clause") {
          for (const impl of clause.namedChildren) {
            const bare = bareTypeName(impl.text);
            if (bare) implementsList.push(bare);
          }
        } else {
          // JavaScript: `class_heritage` holds the extends expression directly.
          extendsName ??= bareTypeName(clause.text) || null;
        }
      }
    }

    const decorators = this.extractDecorators(node);
    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    if (body) {
      for (const member of body.children) {
        if (
          member.type === "method_definition" ||
          member.type === "public_field_definition"
        ) {
          if (member.type === "method_definition") {
            const methodName =
              member.childForFieldName("name")?.text ?? "anonymous";
            const params = this.extractJsParams(
              member.childForFieldName("parameters"),
            );
            const returnType = member.childForFieldName("return_type")?.text?.replace(/^:\s*/, "") ?? null;
            const isAsync = member.text.startsWith("async ");
            const methodBody = member.childForFieldName("body");
            methods.push({
              name: methodName,
              params,
              returnType,
              isAsync,
              isExported: false,
              decorators: this.extractDecorators(member),
              calls: [...extractCalls(methodBody, "typescript"), ...collectDynamicImportCalls(methodBody)],
              line: member.startPosition.row + 1,
              endLine: member.endPosition.row + 1,
            });
          } else {
            const propName =
              member.childForFieldName("name")?.text ?? "unknown";
            properties.push({
              name: propName,
              type: member.childForFieldName("type")?.text?.replace(/^:\s*/, "") ?? null,
              visibility: this.getVisibility(member),
              isStatic: member.text.includes("static "),
              isReadonly: member.text.includes("readonly "),
            });
          }
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
      isExported,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private extractDecorators(node: Node): string[] {
    return extractJsDecorators(node);
  }

  private getVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return getVisibility(node);
  }
}
