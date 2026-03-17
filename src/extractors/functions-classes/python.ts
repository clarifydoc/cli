import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "./base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, Language } from "./base.js";

export class PythonExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["python"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractPythonFunctions(node, functions);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPythonClasses(node, classes);
  }

  private extractPythonFunctions(node: Node, functions: FunctionInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "decorated_definition") {
        const decorators: string[] = [];
        let funcDef: Node | null = null;
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (part.type === "decorator") {
            decorators.push(part.text.replace(/^@/, ""));
          } else if (part.type === "function_definition") {
            funcDef = part;
          }
        }
        if (funcDef) {
          const fn = this.parsePythonFunction(funcDef);
          fn.decorators = decorators;
          functions.push(fn);
        }
      } else if (child.type === "function_definition") {
        functions.push(this.parsePythonFunction(child));
      }
    }
  }

  private parsePythonFunction(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params: ParamInfo[] = [];

    if (paramsNode) {
      for (let i = 0; i < paramsNode.childCount; i++) {
        const p = paramsNode.child(i)!;
        if (p.type === "identifier" || p.type === "typed_parameter" || p.type === "default_parameter") {
          const pName = p.childForFieldName("name")?.text ?? p.text;
          if (pName === "self" || pName === "cls") continue;
          params.push({
            name: pName,
            type: p.childForFieldName("type")?.text ?? null,
            defaultValue: p.childForFieldName("value")?.text ?? null,
          });
        }
      }
    }

    const returnType = node.childForFieldName("return_type")?.text ?? null;
    const isAsync = node.previousSibling?.type === "async" || node.text.startsWith("async ");

    return {
      name,
      params,
      returnType,
      isAsync,
      isExported: !name.startsWith("_"),
      decorators: [],
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }

  private extractPythonClasses(node: Node, classes: ClassInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "decorated_definition") {
        const decorators: string[] = [];
        let classDef: Node | null = null;
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
          if (part.type === "decorator") {
            decorators.push(part.text.replace(/^@/, ""));
          } else if (part.type === "class_definition") {
            classDef = part;
          }
        }
        if (classDef) {
          const cls = this.parsePythonClass(classDef);
          cls.decorators = decorators;
          classes.push(cls);
        }
      } else if (child.type === "class_definition") {
        classes.push(this.parsePythonClass(child));
      }
    }
  }

  private parsePythonClass(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const bases = node.childForFieldName("superclasses");
    let extendsName: string | null = null;

    if (bases && bases.childCount > 0) {
      extendsName = bases.child(0)?.text ?? null;
    }

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];

    if (body) {
      this.extractPythonFunctions(body, methods);
    }

    return {
      name,
      extends: extendsName,
      implements: [],
      decorators: [],
      methods,
      properties: [],
      isExported: !name.startsWith("_"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
  }
}
