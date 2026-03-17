import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "./base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "./base.js";

export class PascalExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["pascal"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractPascalFunctions(node, functions);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPascalClasses(node, classes);
  }

  private extractPascalFunctions(node: Node, functions: FunctionInfo[]): void {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

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
    for (let i = 0; i < declProc.childCount; i++) {
      if (declProc.child(i)!.type === "genericDot") return true;
    }
    return false;
  }

  private parsePascalProc(declProc: Node, parentNode?: Node): FunctionInfo {
    let name = "anonymous";
    let isConstructor = false;
    let isDestructor = false;
    let isFunction = false;

    for (let i = 0; i < declProc.childCount; i++) {
      const child = declProc.child(i)!;
      if (child.type === "identifier") {
        name = child.text;
      } else if (child.type === "genericDot") {
        const parts: string[] = [];
        for (let j = 0; j < child.childCount; j++) {
          const part = child.child(j)!;
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
      for (let i = 0; i < declProc.childCount; i++) {
        const child = declProc.child(i)!;
        if (child.type === "typeref" || (child.type === "type" && declProc.child(i - 1)?.type !== "declArg")) {
          returnType = child.text;
          break;
        }
      }
    }

    const refNode = parentNode ?? declProc;
    return {
      name: isConstructor ? "constructor" : isDestructor ? "destructor" : name,
      params,
      returnType,
      isAsync: false,
      isExported: true,
      decorators: [],
      line: refNode.startPosition.row + 1,
      endLine: refNode.endPosition.row + 1,
    };
  }

  private extractPascalParams(declProc: Node): ParamInfo[] {
    const params: ParamInfo[] = [];
    for (let i = 0; i < declProc.childCount; i++) {
      const child = declProc.child(i)!;
      if (child.type === "declArgs") {
        for (let j = 0; j < child.childCount; j++) {
          const arg = child.child(j)!;
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

    for (let i = 0; i < arg.childCount; i++) {
      const child = arg.child(i)!;
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
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "declType") {
        const typeName = this.getPascalDeclTypeName(child);
        for (let j = 0; j < child.childCount; j++) {
          const inner = child.child(j)!;
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
    for (let i = 0; i < declType.childCount; i++) {
      const child = declType.child(i)!;
      if (child.type === "identifier") return child.text;
    }
    return "anonymous";
  }

  private parsePascalClass(node: Node, name: string, declTypeNode: Node): ClassInfo {
    let extendsName: string | null = null;
    const implementsList: string[] = [];
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;

      if (child.type === "typeref" && !extendsName) {
        extendsName = child.text;
      }

      if (child.type === "declSection") {
        const visibility = this.getPascalSectionVisibility(child);
        for (let j = 0; j < child.childCount; j++) {
          const member = child.child(j)!;
          if (member.type === "declProc") {
            const fn = this.parsePascalProc(member);
            fn.isExported = visibility === "public" || visibility === null;
            methods.push(fn);
          } else if (member.type === "declField") {
            properties.push(this.parsePascalField(member, visibility));
          } else if (member.type === "declProp") {
            properties.push(this.parsePascalProperty(member, visibility));
          }
        }
      }

      if (child.type === "declProc") {
        methods.push(this.parsePascalProc(child));
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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
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
    for (let i = 0; i < section.childCount; i++) {
      const child = section.child(i)!;
      if (child.type === "kPrivate") return "private";
      if (child.type === "kPublic") return "public";
      if (child.type === "kProtected") return "protected";
      if (child.type === "kPublished") return "public";
      if (child.type === "kStrict") {
        const next = section.child(i + 1);
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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
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

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i)!;
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
