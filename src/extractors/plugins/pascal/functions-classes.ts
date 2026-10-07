import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo } from "../../../types/analysis.js";
import { extractCalls, holdNoiseCall, restoreHeldCalls } from "../../shared/call-graph.js";
import { pascalLocalTypes } from "./di.js";

/** Containers whose children are routines / type sections at unit level. */
const UNIT_CONTAINERS = new Set(["unit", "program", "library", "implementation", "root"]);

/** Type declarations that own methods: class / record / object, class & record helpers, interfaces. */
const OWNER_DECLS = new Set(["declClass", "declHelper", "declIntf"]);

/** `type` sections nested in a class body, directly or under a visibility section. */
function nestedTypeSections(decl: Node): Node[] {
  const out: Node[] = [];
  for (const child of decl.children) {
    if (child.type === "declTypes") out.push(child);
    else if (child.type === "declSection") for (const inner of child.children) if (inner.type === "declTypes") out.push(inner);
  }
  return out;
}

/**
 * Whether a unit can hold a local filled from an assignment — a container
 * lookup (`R := GlobalContainer.Resolve<IRepo>`) or an inline variable
 * (`var C := TFoo.Create`). Most units hold neither, and then no routine's
 * assignments are visited.
 */
const ASSIGNED_LOCAL_RE = /:=\s*[\w.]*\b(?:Resolve|GetService)\s*<|\bvar\s+\w+\s*:=/i;

/** One routine implementation (`defProc`): its calls, span and stated locals. */
interface RoutineBody {
  calls: CallInfo[];
  line: number;
  endLine: number;
  localTypes: NonNullable<FunctionInfo["localTypes"]>;
}

export class PascalExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["pascal"];

  /** "Owner.MethodName" (nested owners included: "TOuter.TInner.Go") →
   *  calls + line span of the IMPLEMENTATION block. The interface
   *  declaration is a single line; symbol attribution (and click-through)
   *  need the body span, like every other language. */
  private methodCallsMap = new Map<string, RoutineBody>();

  /** Set per file: whether routine bodies' assignments can state a local's type. */
  private readAssignments = false;

  override extractFunctions(tree: import("web-tree-sitter").Tree, sourceText: string): FunctionInfo[] {
    this.readAssignments = ASSIGNED_LOCAL_RE.test(sourceText);
    return super.extractFunctions(tree, sourceText);
  }

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    // First pass: collect calls from all method implementations. Reset per
    // file — `TForm1.FormCreate` exists in half the units of a VCL app, and a
    // stale entry would attach another file's calls and line span.
    this.methodCallsMap.clear();
    this.buildMethodCallsMap(node);
    this.extractPascalFunctions(node, functions, this.declaredOwners(node));
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPascalClasses(node, classes, this.declaredInterfaces(node), "");
  }

  /** Walk the implementation section to collect calls from method bodies */
  private buildMethodCallsMap(node: Node): void {
    for (const child of node.children) {
      if (child.type === "defProc") {
        const declProc = this.findChildByType(child, "declProc");
        if (declProc && this.isPascalMethodDef(declProc)) {
          const key = this.getMethodKey(declProc);
          if (key && this.findChildByType(child, "block")) this.methodCallsMap.set(key, this.routineBody(child));
        }
      }
      if (UNIT_CONTAINERS.has(child.type)) this.buildMethodCallsMap(child);
    }
  }

  /**
   * Calls, span and locals of one routine. Its body is a nested scope of its
   * own (see call-hooks.ts), so the calls made by its LOCAL procedures — which
   * are not extracted as symbols, and only run on its behalf — are attributed
   * to it here.
   */
  private routineBody(defProc: Node): RoutineBody {
    const block = this.findChildByType(defProc, "block");
    const calls = extractCalls(block, "pascal");
    this.adoptLocalProcCalls(defProc, calls);
    return {
      calls,
      line: defProc.startPosition.row + 1,
      endLine: defProc.endPosition.row + 1,
      localTypes: pascalLocalTypes(defProc, this.readAssignments),
    };
  }

  /**
   * Append the calls of `defProc`'s local procedures (recursively) to
   * `calls` in place, skipping names already recorded. Calls those bodies
   * held back as noise (`repo.find`) move with them, so they are restored
   * against the enclosing routine's scope like its own.
   */
  private adoptLocalProcCalls(defProc: Node, calls: CallInfo[]): void {
    for (const child of defProc.children) {
      if (child.type !== "defProc") continue;
      const nested = extractCalls(this.findChildByType(child, "block"), "pascal");
      const seen = new Set(calls.map((c) => c.name));
      for (const c of nested) {
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        calls.push(c);
      }
      restoreHeldCalls(nested, (held) => {
        if (!seen.has(held.name)) holdNoiseCall(calls, held);
        return false;
      });
      this.adoptLocalProcCalls(child, calls);
    }
  }

  /**
   * `TOuter.TInner.Go` / `TBox<T>.Put` → its dotted owner path + name,
   * generic parameters dropped (`TBox.Put`).
   */
  private qualifiedParts(node: Node): string[] {
    if (node.type === "identifier") return [node.text];
    if (node.type === "genericTpl") {
      const entity = node.child(0);
      return entity ? this.qualifiedParts(entity) : [];
    }
    if (node.type === "genericDot") {
      const parts: string[] = [];
      for (const part of node.children) {
        if (part.type === "identifier" || part.type === "genericDot" || part.type === "genericTpl") {
          parts.push(...this.qualifiedParts(part));
        }
      }
      return parts;
    }
    return [];
  }

  /** "Owner.MethodName" key of a method declProc's genericDot name. */
  private getMethodKey(declProc: Node): string | null {
    for (const child of declProc.children) {
      if (child.type === "genericDot") {
        const parts = this.qualifiedParts(child);
        if (parts.length >= 2) return parts.join(".");
      }
    }
    return null;
  }

  /**
   * Dotted paths of every method-owning type declared in this file
   * (`TOrderService`, `TOuter.TInner`, `TStringsHelper`), so a method
   * implementation whose owner is declared elsewhere (an `{$I}` include) can
   * still be extracted.
   */
  private declaredOwners(root: Node): Set<string> {
    const owners = new Set<string>();
    const visit = (node: Node, prefix: string): void => {
      for (const child of node.children) {
        if (child.type === "declType") {
          const name = this.getPascalDeclTypeName(child);
          const decl = child.children.find((c) => OWNER_DECLS.has(c.type));
          if (decl) {
            const path = prefix ? `${prefix}.${name}` : name;
            owners.add(path);
            for (const nested of nestedTypeSections(decl)) visit(nested, path);
          }
        } else if (UNIT_CONTAINERS.has(child.type) || child.type === "interface" || child.type === "declTypes") {
          visit(child, prefix);
        }
      }
    };
    visit(root, "");
    return owners;
  }

  /** Names of the interfaces this file declares — a class's first parent may be one. */
  private declaredInterfaces(root: Node): Set<string> {
    const names = new Set<string>();
    const visit = (node: Node): void => {
      for (const child of node.children) {
        if (child.type === "declType") {
          if (child.children.some((c) => c.type === "declIntf")) names.add(this.getPascalDeclTypeName(child).toLowerCase());
        } else if (UNIT_CONTAINERS.has(child.type) || child.type === "interface" || child.type === "declTypes") {
          visit(child);
        }
      }
    };
    visit(root);
    return names;
  }

  private extractPascalFunctions(node: Node, functions: FunctionInfo[], owners: Set<string>): void {
    for (const child of node.children) {

      if (child.type === "defProc") {
        const declProc = this.findChildByType(child, "declProc");
        if (declProc && !this.isPascalMethodDef(declProc)) {
          functions.push(this.parsePascalProc(declProc, child));
        } else if (declProc) {
          // A method whose owner is not declared in this unit (an include
          // file's class) has no class here to adopt it: keep it as a
          // routine under its qualified name rather than lose its calls.
          const key = this.getMethodKey(declProc);
          const owner = key ? key.slice(0, key.lastIndexOf(".")) : null;
          if (key && owner && !owners.has(owner)) {
            const fn = this.parsePascalProc(declProc, child);
            fn.name = key;
            functions.push(fn);
          }
        }
      }

      if (UNIT_CONTAINERS.has(child.type)) this.extractPascalFunctions(child, functions, owners);
    }
  }

  private isPascalMethodDef(declProc: Node): boolean {
    for (const child of declProc.children) {
      if (child.type === "genericDot") return true;
    }
    return false;
  }

  /** The routine's name as declared (`Create` for a constructor, the last part of `TFoo.Bar`). */
  private declaredName(declProc: Node): string {
    let name = "anonymous";
    for (const child of declProc.children) {
      if (child.type === "identifier") name = child.text;
      else if (child.type === "genericDot") name = this.qualifiedParts(child).pop() ?? "anonymous";
    }
    return name;
  }

  private parsePascalProc(declProc: Node, parentNode?: Node): FunctionInfo {
    let isConstructor = false;
    let isDestructor = false;
    let isFunction = false;

    for (const child of declProc.children) {
      if (child.type === "kConstructor") {
        isConstructor = true;
      } else if (child.type === "kDestructor") {
        isDestructor = true;
      } else if (child.type === "kFunction") {
        isFunction = true;
      }
    }
    const name = this.declaredName(declProc);

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
    const body = parentNode ? this.routineBody(parentNode) : null;
    const fn: FunctionInfo = {
      name: isConstructor ? "constructor" : isDestructor ? "destructor" : name,
      params,
      returnType,
      isAsync: false,
      isExported: true,
      decorators: [],
      calls: body?.calls ?? [],
      line: refNode.startPosition.row + 1,
      endLine: refNode.endPosition.row + 1,
    };
    if (body && body.localTypes.length > 0) fn.localTypes = body.localTypes;
    return fn;
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

    return names.map((n) => ({
      name: n,
      type,
      defaultValue: hasDefault ? defaultValue : null,
    }));
  }

  /**
   * Classes, records, objects, helpers and interfaces — nested types too
   * (`TOuter = class type TInner = class … end; …`), whose methods are
   * implemented as `TOuter.TInner.Go`. `prefix` is the enclosing type path.
   */
  private extractPascalClasses(node: Node, classes: ClassInfo[], interfaces: Set<string>, prefix: string): void {
    for (const child of node.children) {

      if (child.type === "declType") {
        const typeName = this.getPascalDeclTypeName(child);
        const path = prefix ? `${prefix}.${typeName}` : typeName;
        for (const inner of child.children) {
          if (inner.type === "declClass" || inner.type === "declHelper") {
            classes.push(this.parsePascalClass(inner, typeName, path, child, interfaces));
            for (const nested of nestedTypeSections(inner)) this.extractPascalClasses(nested, classes, interfaces, path);
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
        this.extractPascalClasses(child, classes, interfaces, prefix);
      }
    }
  }

  /** `TFoo` of `TFoo = class …`, `TBox` of `TBox<T> = class …`. */
  private getPascalDeclTypeName(declType: Node): string {
    for (const child of declType.children) {
      if (child.type === "identifier") return child.text;
      if (child.type === "genericTpl") return this.qualifiedParts(child)[0] ?? "anonymous";
    }
    return "anonymous";
  }

  /** A declared method adopts its implementation's calls, span and locals. */
  private adoptImplementation(fn: FunctionInfo, key: string): void {
    const impl = this.methodCallsMap.get(key);
    if (!impl) return;
    fn.calls = impl.calls;
    fn.line = impl.line;
    fn.endLine = impl.endLine;
    if (impl.localTypes.length > 0) fn.localTypes = impl.localTypes;
  }

  private parsePascalClass(
    node: Node,
    name: string,
    path: string,
    declTypeNode: Node,
    interfaces: Set<string>,
  ): ClassInfo {
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    // `class(TInterfacedObject, IFoo, IBar)`: the first parent is the base
    // class, the rest are implemented interfaces. A class may also list only
    // interfaces (`class(IFoo)` derives from TObject) — when the first parent
    // is an interface this unit declares, it is one of those.
    const parents = node.type === "declClass" ? node.children.filter((c) => c.type === "typeref").map((c) => c.text) : [];
    let extendsName: string | null = null;
    const implementsList: string[] = [];
    parents.forEach((parent, i) => {
      const bare = parent.replace(/<[\s\S]*$/, "").split(".").pop()!.toLowerCase();
      if (i === 0 && !interfaces.has(bare)) extendsName = parent;
      else implementsList.push(parent);
    });

    const addMethod = (member: Node, visibility: "public" | "private" | "protected" | null | undefined): void => {
      const fn = this.parsePascalProc(member);
      if (visibility !== undefined) fn.isExported = visibility === "public" || visibility === null;
      // Adopt the implementation's calls AND line span (the interface
      // declaration is one line — useless for attribution/navigation). The
      // key is the name as declared: a constructor is `TFoo.Create` in the
      // implementation even though it is reported as `constructor`.
      this.adoptImplementation(fn, `${path}.${this.declaredName(member)}`);
      methods.push(fn);
    };

    for (const child of node.children) {
      if (child.type === "declSection") {
        const visibility = this.getPascalSectionVisibility(child);
        for (const member of child.children) {
          if (member.type === "declProc") {
            addMethod(member, visibility);
          } else if (member.type === "declField") {
            properties.push(...this.parsePascalField(member, visibility));
          } else if (member.type === "declProp") {
            properties.push(this.parsePascalProperty(member, visibility));
          }
        }
      }

      if (child.type === "declProc") {
        addMethod(child, undefined);
      } else if (child.type === "declField") {
        properties.push(...this.parsePascalField(child, null));
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

  /**
   * `IFoo = interface(IBase) ['{GUID}'] … end`: the methods are signatures
   * only (no implementation, no calls); the parent interface is `extends`.
   */
  private parsePascalInterface(node: Node, name: string, declTypeNode: Node): ClassInfo {
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];
    let extendsName: string | null = null;

    for (const child of node.children) {
      if (child.type === "declProc") {
        methods.push(this.parsePascalProc(child));
      } else if (child.type === "declProp") {
        properties.push(this.parsePascalProperty(child, null));
      } else if (child.type === "typeref" && !extendsName) {
        extendsName = child.text;
      }
    }

    return {
      name,
      kind: "interface",
      extends: extendsName,
      implements: [],
      decorators: [],
      methods,
      properties,
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

  /**
   * `[Inject('email')] FNotifier: INotifier;` / `FA, FB: IFoo;` — one
   * property per declared name. RTTI attributes are kept as decorators with
   * their arguments; Spring4D's `[Inject('name')]` names the registration the
   * container injects (`qualifier`).
   */
  private parsePascalField(
    node: Node,
    visibility: "public" | "private" | "protected" | null,
  ): PropertyInfo[] {
    const names: string[] = [];
    let type: string | null = null;
    const decorators: string[] = [];
    let qualifier: string | undefined;

    for (const child of node.children) {
      if (child.type === "identifier") names.push(child.text);
      else if (child.type === "type") type = child.text;
      else if (child.type === "rttiAttributes") {
        for (const attr of child.namedChildren) {
          if (attr.type !== "identifier" && attr.type !== "exprCall") continue;
          decorators.push(attr.text.replace(/\s+/g, " "));
          const injected = attr.type === "exprCall" ? this.injectName(attr) : null;
          if (injected) qualifier = injected;
        }
      }
    }

    return names.map((name) => {
      const prop: PropertyInfo = { name, type, visibility, isStatic: false, isReadonly: false };
      if (decorators.length > 0) prop.decorators = [...decorators];
      if (qualifier) prop.qualifier = qualifier;
      return prop;
    });
  }

  /** `Inject('email')` → `email`; any other attribute, or a non-literal argument, → null. */
  private injectName(attr: Node): string | null {
    const entity = attr.child(0);
    if (!entity || entity.type !== "identifier" || !/^Inject(?:Attribute)?$/i.test(entity.text)) return null;
    const args = this.findChildByType(attr, "exprArgs");
    const literal = args?.namedChildren.find((a) => a.type === "literalString");
    if (!literal) return null;
    const t = literal.text;
    return t.length >= 2 ? t.slice(1, -1).replace(/''/g, "'") : null;
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
