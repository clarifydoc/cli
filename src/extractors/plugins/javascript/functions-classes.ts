import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo } from "../../../types/analysis.js";
import { getVisibility, extractJsDecorators, stripQuotes } from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";

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
          }
        }
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
      let isExported = false;

      if (child.type === "export_statement") {
        isExported = true;
        for (const inner of child.children) {
          if (inner.type === "class_declaration") {
            classes.push(this.parseJsClass(inner, true));
          }
        }
        continue;
      }

      if (child.type === "class_declaration") {
        classes.push(this.parseJsClass(child, isExported));
      }
    }
  }

  private parseJsClass(node: Node, isExported: boolean): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const heritage = node.childForFieldName("heritage");
    let extendsName: string | null = null;
    const implementsList: string[] = [];

    if (heritage) {
      for (const clause of heritage.children) {
        if (clause.type === "extends_clause") {
          extendsName = clause.child(1)?.text ?? null;
        }
        if (clause.type === "implements_clause") {
          const kids = clause.children;
          for (let j = 1; j < kids.length; j++) {
            const impl = kids[j]!;
            if (impl.type !== ",") implementsList.push(impl.text);
          }
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
