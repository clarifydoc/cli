import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";

export class PascalExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["pascal"];

  /** Map of "ClassName.MethodName" → CallInfo[] built from implementation section */
  private methodCallsMap = new Map<string, import("../../../types/analysis.js").CallInfo[]>();

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    // First pass: collect calls from all method implementations
    this.buildMethodCallsMap(node);
    this.extractPascalFunctions(node, functions);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPascalClasses(node, classes);
  }

  /** Walk the implementation section to collect calls from method bodies */
  private buildMethodCallsMap(node: Node): void {
    for (const child of node.children) {
      if (child.type === "defProc") {
        const declProc = this.findChildByType(child, "declProc");
        if (declProc && this.isPascalMethodDef(declProc)) {
          const key = this.getMethodKey(declProc);
          const block = this.findChildByType(child, "block");
          if (key && block) {
            this.methodCallsMap.set(key, extractCalls(block, "pascal"));
          }
        }
      }
      if (
        child.type === "unit" || child.type === "program" ||
        child.type === "library" || child.type === "implementation" ||
        child.type === "root"
      ) {
        this.buildMethodCallsMap(child);
      }
    }
  }

  /** Get "ClassName.MethodName" key from a method declProc's genericDot */
  private getMethodKey(declProc: Node): string | null {
    for (const child of declProc.children) {
      if (child.type === "genericDot") {
        const parts: string[] = [];
        for (const part of child.children) {
          if (part.type === "identifier") parts.push(part.text);
        }
        if (parts.length >= 2) return parts.join(".");
      }
    }
    return null;
  }

  private extractPascalFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.children) {

      if (child.type === "defProc") {
        const declProc = this.findChildByType(child, "declProc");
        if (declProc && !this.isPascalMethodDef(declProc)) {
          functions.push(this.parsePascalProc(declProc, child));
        }
      }

      if (
        child.type === "unit" ||
        child.type === "program" ||
        child.type === "library" ||
        child.type === "implementation" ||
        child.type === "root"
      ) {
        this.extractPascalFunctions(child, functions);
      }
    }
  }

  private isPascalMethodDef(declProc: Node): boolean {
    for (const child of declProc.children) {
      if (child.type === "genericDot") return true;
    }
    return false;
  }

  private parsePascalProc(declProc: Node, parentNode?: Node): FunctionInfo {
    let name = "anonymous";
    let isConstructor = false;
    let isDestructor = false;
    let isFunction = false;

    for (const child of declProc.children) {
      if (child.type === "identifier") {
        name = child.text;
      } else if (child.type === "genericDot") {
        const parts: string[] = [];
        for (const part of child.children) {
          if (part.type === "identifier") parts.push(part.text);
        }
        name = parts[parts.length - 1] ?? "anonymous";
      } else if (child.type === "kConstructor") {
        isConstructor = true;
      } else if (child.type === "kDestructor") {
        isDestructor = true;
      } else if (child.type === "kFunction") {
        isFunction = true;
      }
    }

    const params = this.extractPascalParams(declProc);

    let returnType: string | null = null;
    if (isFunction) {
      const kids = declProc.children;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i]!;
        if (child.type === "typeref" || (child.type === "type" && kids[i - 1]?.type !== "declArg")) {
          returnType = child.text;
          break;
        }
      }
    }

    const refNode = parentNode ?? declProc;
    // Pascal function body is the block child of defProc (the parent)
    const bodyNode = parentNode ? this.findChildByType(parentNode, "block") : null;
    return {
      name: isConstructor ? "constructor" : isDestructor ? "destructor" : name,
      params,
      returnType,
      isAsync: false,
      isExported: true,
      decorators: [],
      calls: extractCalls(bodyNode, "pascal"),
      line: refNode.startPosition.row + 1,
      endLine: refNode.endPosition.row + 1,
    };
  }

  private extractPascalParams(declProc: Node): ParamInfo[] {
    const params: ParamInfo[] = [];
    for (const child of declProc.children) {
      if (child.type === "declArgs") {
        for (const arg of child.children) {
          if (arg.type === "declArg") {
            const argParams = this.parsePascalArg(arg);
            params.push(...argParams);
          }
        }
      }
    }
    return params;
  }

  private parsePascalArg(arg: Node): ParamInfo[] {
    const names: string[] = [];
    let type: string | null = null;
    let hasDefault = false;
    let defaultValue: string | null = null;

    for (const child of arg.children) {
      if (child.type === "identifier") {
        names.push(child.text);
      } else if (child.type === "type") {
        type = child.text;
      } else if (child.type === "defaultValue") {
        hasDefault = true;
        defaultValue = child.text.replace(/^=\s*/, "");
      }
    }

    if (type && names.length > 1) {
      // All identifiers before the type node are parameter names
    }

    return names.map((n) => ({
      name: n,
      type,
      defaultValue: hasDefault ? defaultValue : null,
    }));
  }

  private extractPascalClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {

      if (child.type === "declType") {
        const typeName = this.getPascalDeclTypeName(child);
        for (const inner of child.children) {
          if (inner.type === "declClass") {
            classes.push(this.parsePascalClass(inner, typeName, child));
          } else if (inner.type === "declIntf") {
            classes.push(this.parsePascalInterface(inner, typeName, child));
          }
        }
      }

      if (
        child.type === "unit" ||
        child.type === "program" ||
        child.type === "library" ||
        child.type === "interface" ||
        child.type === "implementation" ||
        child.type === "declTypes" ||
        child.type === "root"
      ) {
        this.extractPascalClasses(child, classes);
      }
    }
  }

  private getPascalDeclTypeName(declType: Node): string {
    for (const child of declType.children) {
      if (child.type === "identifier") return child.text;
    }
    return "anonymous";
  }

  private parsePascalClass(node: Node, name: string, declTypeNode: Node): ClassInfo {
    let extendsName: string | null = null;
    const implementsList: string[] = [];
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    for (const child of node.children) {

      if (child.type === "typeref" && !extendsName) {
        extendsName = child.text;
      }

      if (child.type === "declSection") {
        const visibility = this.getPascalSectionVisibility(child);
        for (const member of child.children) {
          if (member.type === "declProc") {
            const fn = this.parsePascalProc(member);
            fn.isExported = visibility === "public" || visibility === null;
            // Look up calls from implementation section
            const implCalls = this.methodCallsMap.get(`${name}.${fn.name}`);
            if (implCalls) fn.calls = implCalls;
            methods.push(fn);
          } else if (member.type === "declField") {
            properties.push(this.parsePascalField(member, visibility));
          } else if (member.type === "declProp") {
            properties.push(this.parsePascalProperty(member, visibility));
          }
        }
      }

      if (child.type === "declProc") {
        const fn = this.parsePascalProc(child);
        const implCalls = this.methodCallsMap.get(`${name}.${fn.name}`);
        if (implCalls) fn.calls = implCalls;
        methods.push(fn);
      } else if (child.type === "declField") {
        properties.push(this.parsePascalField(child, null));
      } else if (child.type === "declProp") {
        properties.push(this.parsePascalProperty(child, null));
      }
    }

    return {
      name,
      extends: extendsName,
      implements: implementsList,
      decorators: [],
      methods,
      properties,
      isExported: true,
      line: declTypeNode.startPosition.row + 1,
      endLine: declTypeNode.endPosition.row + 1,
    };
  }

  private parsePascalInterface(node: Node, name: string, declTypeNode: Node): ClassInfo {
    const methods: FunctionInfo[] = [];

    for (const child of node.children) {
      if (child.type === "declProc") {
        methods.push(this.parsePascalProc(child));
      }
    }

    return {
      name,
      extends: null,
      implements: [],
      decorators: [],
      methods,
      properties: [],
      isExported: true,
      line: declTypeNode.startPosition.row + 1,
      endLine: declTypeNode.endPosition.row + 1,
    };
  }

  private getPascalSectionVisibility(
    section: Node,
  ): "public" | "private" | "protected" | null {
    const kids = section.children;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i]!;
      if (child.type === "kPrivate") return "private";
      if (child.type === "kPublic") return "public";
      if (child.type === "kProtected") return "protected";
      if (child.type === "kPublished") return "public";
      if (child.type === "kStrict") {
        const next = kids[i + 1];
        if (next?.type === "kPrivate") return "private";
        if (next?.type === "kProtected") return "protected";
      }
    }
    return null;
  }

  private parsePascalField(
    node: Node,
    visibility: "public" | "private" | "protected" | null,
  ): PropertyInfo {
    let name = "unknown";
    let type: string | null = null;

    for (const child of node.children) {
      if (child.type === "identifier") name = child.text;
      if (child.type === "type") type = child.text;
    }

    return {
      name,
      type,
      visibility,
      isStatic: false,
      isReadonly: false,
    };
  }

  private parsePascalProperty(
    node: Node,
    visibility: "public" | "private" | "protected" | null,
  ): PropertyInfo {
    let name = "unknown";
    let type: string | null = null;
    let hasWrite = false;

    for (const child of node.children) {
      if (child.type === "identifier" && name === "unknown") name = child.text;
      if (child.type === "type") type = child.text;
      if (child.type === "kWrite") hasWrite = true;
    }

    return {
      name,
      type,
      visibility,
      isStatic: false,
      isReadonly: !hasWrite,
    };
  }
}
