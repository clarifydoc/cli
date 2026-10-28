import { constantString } from "./constant-expr.js";
import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, PropertyInfo, Language } from "../../functions-classes/base.js";
import {
  getVisibility,
  hasModifier as sharedHasModifier,
  extractCsharpAttributes,
} from "../../shared/node-helpers.js";
import { extractCalls } from "../../shared/call-graph.js";
import { typeCsharpVariableArgs } from "./arg-kinds.js";
import {
  FileScopeNodes,
  injectionKey,
  unwrapExpression,
  PARAM_KEY_ATTRIBUTES,
  PROPERTY_KEY_ATTRIBUTES,
} from "./local-types.js";

export class CSharpExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["csharp"];

  /**
   * Methods live in classes (collectClasses). The exception is a local
   * function declared among top-level statements — `Program.cs`, and every
   * `.csx` script, whose helpers are all written that way: it is the file's
   * own function, callable from anywhere in those statements.
   */
  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.scope = new FileScopeNodes(node);
    try {
      for (const stmt of node.namedChildren) {
        if (stmt.type !== "global_statement") continue;
        const fnNode = stmt.namedChildren.find((c) => c.type === "local_function_statement");
        if (fnNode) functions.push(this.parseCsharpMethod(fnNode));
      }
    } finally {
      this.scope = null;
    }
  }

  /** The file being extracted's declaration/assignment nodes (one query per file). */
  private scope: FileScopeNodes | null = null;

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.scope = new FileScopeNodes(node);
    try {
      this.extractCsharpClasses(node, classes);
    } finally {
      this.scope = null;
    }
  }

  private extractCsharpClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {

      if (
        child.type === "namespace_declaration" ||
        child.type === "file_scoped_namespace_declaration"
      ) {
        const body = child.childForFieldName("body");
        if (body) this.extractCsharpClasses(body, classes);
        this.extractCsharpClasses(child, classes);
      } else if (
        child.type === "class_declaration" ||
        // Records (`record X(...)`, `record struct`, `record class`) and structs
        // are named types referenced across files exactly like classes — the CQRS
        // commands/queries in this codebase are ALL records, so without these the
        // symbol linker can't resolve `new XQuery()` / `Error.Forbidden` to their
        // definitions (it has no entry in the class catalog).
        child.type === "record_declaration" ||
        child.type === "struct_declaration"
      ) {
        classes.push(this.parseCsharpClass(child, "class"));
        // Nested types are types of their own (`Outer.Handler` is referred to as `Handler`).
        const body = child.childForFieldName("body");
        if (body) this.extractCsharpClasses(body, classes);
      } else if (child.type === "interface_declaration") {
        classes.push(this.parseCsharpClass(child, "interface"));
      } else if (child.type === "enum_declaration") {
        classes.push(this.parseCsharpEnum(child));
      }
    }
  }

  private parseCsharpClass(node: Node, kind: "class" | "interface"): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    // C# cannot tell a base class from an interface syntactically: the first
    // base goes to `extends`, the rest to `implements` (consumers check both).
    const [extendsName = null, ...implementsList] = baseTypeTexts(node);

    const decorators = extractCsharpAttributes(node);
    // C#: default class visibility is internal, check for public
    const classVis = this.getCsharpVisibility(node);

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    // C# 12 primary constructor (`class S(IRepo repo)`, records, structs): its
    // parameters are in scope in every member, which is what lets the linker
    // type a bare `repo.Find()` — reported as the constructor they are.
    // A field that stores a keyed constructor parameter holds the keyed
    // instance: `_storage = storage;` with `[FromKeyedServices("disk")]
    // IStorage storage` gives `_storage` the qualifier `disk`.
    const fieldKeys = new Map<string, string | null>();
    // Non-public fields of a named type → every value the class stores in them
    // (initializer + assignments), to tell a constructed field from an injected one.
    const fieldValues = new Map<string, { prop: PropertyInfo; values: Node[] }>();
    let primaryKeys: ReadonlyMap<string, string> = new Map();
    const primaryParams = node.namedChildren.find((c) => c.type === "parameter_list");
    if (primaryParams && primaryParams.namedChildren.some((c) => c.type === "parameter")) {
      const params = this.parseCsharpParams(primaryParams);
      primaryKeys = keyedParams(params);
      methods.push({
        name,
        params,
        returnType: null,
        isAsync: false,
        isExported: classVis === "public" || classVis === null,
        decorators: [],
        calls: [],
        line: primaryParams.startPosition.row + 1,
        endLine: primaryParams.endPosition.row + 1,
      });
    }

    if (body) {
      for (const member of body.children) {
        if (member.type === "method_declaration" || member.type === "constructor_declaration") {
          // Constructors keep the class's name (`isConstructor` in core): their
          // parameters are the injection points, their bodies make calls.
          const fn = this.parseCsharpMethod(member);
          methods.push(fn);
          if (member.type === "constructor_declaration") {
            noteKeyedAssignments(this.assignmentsIn(member.childForFieldName("body")), keyedParams(fn.params), fieldKeys);
          }
        } else if (member.type === "property_declaration") {
          const propName =
            member.childForFieldName("name")?.text ?? "unknown";
          const prop: PropertyInfo = {
            name: propName,
            type: member.childForFieldName("type")?.text ?? null,
            visibility: this.getCsharpVisibility(member),
            isStatic: this.hasModifier(member, "static"),
            isReadonly: this.hasModifier(member, "readonly"),
          };
          // `[Required]` / `[JsonPropertyName("x")]` and the C# 11 `required`
          // modifier are what a request schema needs; only set when present so
          // the per-file JSON of attribute-less models is unchanged in shape.
          const attrs = extractCsharpAttributes(member);
          if (attrs.length > 0) prop.decorators = attrs;
          if (this.hasModifier(member, "required")) prop.isRequired = true;
          // `[Inject(Key = "k")]` (Blazor), `[Dependency("n")]` (Unity).
          if (attrs.length > 0) {
            const key = injectionKey(member, PROPERTY_KEY_ATTRIBUTES);
            if (key) prop.qualifier = key;
          }
          properties.push(prop);
        } else if (member.type === "field_declaration") {
          // private readonly Foo _bar; — the tree-sitter shape is
          // field_declaration → variable_declaration { type, variable_declarator { name } }
          const typeText = member.childForFieldName("type")?.text
            ?? this.findChildByType(member, "variable_declaration")
              ?.childForFieldName("type")?.text
            ?? null;
          const varDecl = this.findChildByType(member, "variable_declaration");
          if (varDecl) {
            for (const decl of varDecl.children) {
              if (decl.type === "variable_declarator") {
                const nameNode = decl.childForFieldName("name");
                const fieldName = nameNode?.text ?? decl.text;
                // `private readonly IStorage _s = storage;` from a keyed primary-constructor parameter.
                if (primaryKeys.size > 0) {
                  const init = decl.namedChildren.find((c) => c.id !== nameNode?.id);
                  const key = init ? primaryKeys.get(storedName(init) ?? "") : undefined;
                  if (key) noteKey(fieldKeys, fieldName, key);
                }
                const prop: PropertyInfo = {
                  name: fieldName,
                  type: typeText,
                  visibility: this.getCsharpVisibility(member),
                  isStatic: this.hasModifier(member, "static"),
                  isReadonly: this.hasModifier(member, "readonly"),
                };
                properties.push(prop);
                const typeNode = varDecl.childForFieldName("type");
                if (prop.visibility !== "public" && typeNode && NAMED_FIELD_TYPES.has(typeNode.type)) {
                  const init = decl.namedChildren.find((c) => c.id !== nameNode?.id && c.type !== "bracketed_argument_list");
                  fieldValues.set(fieldName, { prop, values: init ? [init] : [] });
                }
              }
            }
          }
        }
      }
    }

    for (const prop of properties) {
      const key = fieldKeys.get(prop.name);
      if (key && !prop.qualifier) prop.qualifier = key;
    }
    if (body && fieldValues.size > 0) refineConstructedFields(this.assignmentsIn(body), fieldValues);
    const strings = body ? this.stringFieldValues(body) : null;
    const superArgs = body ? baseInitializerArgs(body) : null;

    const typeParameters = node.children
      .find((c) => c.type === "type_parameter_list")
      ?.namedChildren.filter((c) => c.type === "type_parameter")
      .map((c) => (c.childForFieldName("name") ?? c.namedChildren.find((n) => n.type === "identifier"))?.text ?? "")
      .filter(Boolean);

    return {
      name,
      extends: extendsName,
      implements: implementsList,
      ...(typeParameters?.length ? { typeParameters } : {}),
      decorators,
      methods,
      properties,
      ...(strings ? { fieldValues: strings } : {}),
      ...(superArgs ? { superArgs } : {}),
      isExported: classVis === "public" || classVis === null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind,
    };
  }

  /** `enum Role { Guest, Admin = 2 }` → a class of kind "enum" whose members are its properties. */
  private parseCsharpEnum(node: Node): ClassInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const properties: PropertyInfo[] = [];
    const body = node.childForFieldName("body") ?? this.findChildByType(node, "enum_member_declaration_list");
    for (const member of body?.children ?? []) {
      if (member.type !== "enum_member_declaration") continue;
      const memberName = member.childForFieldName("name")?.text ?? this.findChildByType(member, "identifier")?.text;
      if (!memberName) continue;
      properties.push({ name: memberName, type: name, visibility: "public", isStatic: true, isReadonly: true });
    }
    const classVis = this.getCsharpVisibility(node);
    return {
      name,
      extends: null,
      implements: [],
      decorators: extractCsharpAttributes(node),
      methods: [],
      properties,
      isExported: classVis === "public" || classVis === null,
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      kind: "enum",
    };
  }

  private parseCsharpMethod(node: Node): FunctionInfo {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params = paramsNode ? this.parseCsharpParams(paramsNode) : [];

    // `returns` in the current grammar (`type` in older ones); a constructor has neither.
    const returnType = (node.childForFieldName("returns") ?? node.childForFieldName("type"))?.text ?? null;
    const isAsync = this.hasModifier(node, "async");
    const decorators = extractCsharpAttributes(node);
    const body = node.childForFieldName("body");

    // C#: methods default to private
    const methodVis = this.getCsharpVisibility(node);
    const fn: FunctionInfo = {
      name,
      params,
      returnType,
      isAsync,
      isExported: methodVis === "public",
      decorators,
      calls: extractCalls(body, "csharp"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    const localTypes = this.scope?.localTypesOf(body);
    if (localTypes) fn.localTypes = localTypes;
    typeCsharpVariableArgs(fn.calls, params, body);
    return fn;
  }

  /**
   * A `parameter_list`'s parameters. The DI key on an injection point
   * (`[FromKeyedServices("k")]`, Autofac `[KeyFilter("k")]`) is its qualifier;
   * `[FromServices]` needs none — the declared type is the request.
   */
  private parseCsharpParams(paramsNode: Node): ParamInfo[] {
    const params: ParamInfo[] = [];
    const kids = paramsNode.children;
    for (let i = 0; i < kids.length; i++) {
      const p = kids[i]!;
      // `params string[] rest`: the grammar lays it out as loose tokens in the
      // list (`params`, the type, the name), not as a `parameter` node.
      if (p.type === "params") {
        const type = kids[i + 1];
        const name = kids[i + 2];
        if (type && name?.type === "identifier") {
          params.push({ name: name.text, type: type.text, defaultValue: null, variadic: true });
          i += 2;
        }
        continue;
      }
      if (p.type !== "parameter") continue;
      const param: ParamInfo = {
        name: p.childForFieldName("name")?.text ?? p.text,
        type: p.childForFieldName("type")?.text ?? null,
        defaultValue: csharpDefaultValue(p),
      };
      if (p.firstChild?.type === "attribute_list") {
        const key = injectionKey(p, PARAM_KEY_ATTRIBUTES);
        if (key) param.qualifier = key;
        // `[FromServices]` (and a keyed one): the container supplies it.
        else if (/\[\s*(?:[\w.]+\.)?FromServices(?:Attribute)?\s*[\],(]/.test(p.text)) param.injected = true;
      }
      // `static T M(this IServiceCollection s, …)` — an extension method: the
      // call site writes this parameter as the receiver (`services.M(…)`).
      if (p.namedChildren.some((c) => c.type === "modifier" && c.text === "this")) {
        param.isReceiver = true;
      }
      params.push(param);
    }
    return params;
  }

  /**
   * The string a class gives each of its string fields (`ClassInfo.fieldValues`):
   * a literal initializer (`protected const string BasePath = "api";`) or a
   * constructor's assignment of a literal or of one of its parameters
   * (`BaseVersion = baseVersion;` → `${baseVersion}`, which the core fills
   * with what a subclass passes to `base(…)`). A field given two different
   * values is left out.
   */
  private stringFieldValues(body: Node): Record<string, string> | null {
    const values = new Map<string, string | null>();
    const note = (name: string, value: string | null): void => {
      values.set(name, values.has(name) && values.get(name) !== value ? null : value);
    };
    for (const member of body.namedChildren) {
      if (member.type === "field_declaration") {
        const decl = this.findChildByType(member, "variable_declaration");
        if (decl?.childForFieldName("type")?.text !== "string") continue;
        for (const d of decl.namedChildren) {
          if (d.type !== "variable_declarator") continue;
          const name = d.childForFieldName("name")?.text;
          const init = d.namedChildren.find((c) => c.type === "string_literal" || c.type === "verbatim_string_literal");
          if (name && init) note(name, plainString(init));
          // `const string Club = Clubs + "/{id}"`: a constant built from others, the names kept as holes.
          else if (name && /\bconst\b/.test(member.namedChildren.filter((c) => c.type === "modifier").map((c) => c.text).join(" "))) {
            const built = constantString(d.namedChildren[d.namedChildren.length - 1] ?? null);
            if (built !== null && built.includes("${")) note(name, built);
          }
        }
      } else if (member.type === "constructor_declaration") {
        const paramList = member.childForFieldName("parameters");
        const params = new Set(paramList ? this.parseCsharpParams(paramList).map((p) => p.name) : []);
        for (const a of this.assignmentsIn(member.childForFieldName("body"))) {
          const left = a.childForFieldName("left");
          const right = a.childForFieldName("right");
          if (!left || !right) continue;
          const name = left.type === "identifier" ? left.text
            : left.type === "member_access_expression" && left.firstChild?.type === "this" ? left.childForFieldName("name")?.text : undefined;
          if (!name) continue;
          if (right.type === "identifier" && params.has(right.text)) note(name, `\${${right.text}}`);
          else if (right.type === "string_literal" || right.type === "verbatim_string_literal") note(name, plainString(right));
        }
      }
    }
    const out: Record<string, string> = {};
    for (const [name, value] of values) if (value !== null) out[name] = value;
    return Object.keys(out).length > 0 ? out : null;
  }

  private assignmentsIn(scope: Node | null): Node[] {
    return scope && this.scope ? this.scope.within(scope, ASSIGNMENT) : [];
  }

  private getCsharpVisibility(
    node: Node,
  ): "public" | "private" | "protected" | null {
    return getVisibility(node);
  }

  private hasModifier(node: Node, modifier: string): boolean {
    return sharedHasModifier(node, modifier);
  }

}

/**
 * The base types a type declaration names, as written (`IRepo<User>`,
 * `N.IBar`, `IRequestHandler<Q, R>` — consumers strip what they need). A
 * primary-constructor base call (`: Base(x)`) contributes its type, never its
 * argument list.
 */
export function baseTypeTexts(decl: Node): string[] {
  const bases = decl.childForFieldName("bases") ?? decl.namedChildren.find((c) => c.type === "base_list") ?? null;
  const out: string[] = [];
  for (const base of bases?.namedChildren ?? []) {
    if (base.type === "argument_list" || base.type === "comment") continue;
    if (base.type === "primary_constructor_base_type") {
      const t = base.childForFieldName("type") ?? base.namedChild(0);
      if (t) out.push(t.text);
      continue;
    }
    out.push(base.text);
  }
  return out;
}

const ASSIGNMENT: ReadonlySet<string> = new Set(["assignment_expression"]);

/** Declared field types that can name a project class (an interface the container could bind). */
const NAMED_FIELD_TYPES: ReadonlySet<string> = new Set(["identifier", "generic_name", "qualified_name", "nullable_type"]);

/**
 * A private field the class only ever fills with `new X(..)` (initializer or
 * assignments, all the same class) holds an X — not whatever a container
 * binds for its declared interface. `private readonly IClock _clock = new
 * SystemClock();` is typed `SystemClock`, so `_clock.Now()` never follows an
 * `AddSingleton<IClock, …>` meant for injected clocks. A field assigned
 * anything else anywhere (a constructor parameter, a factory call) keeps its
 * declared type.
 */
function refineConstructedFields(assignments: Node[], fields: Map<string, { prop: PropertyInfo; values: Node[] }>): void {
  for (const a of assignments) {
    const left = a.childForFieldName("left");
    if (!left) continue;
    let target: string | null = null;
    if (left.type === "identifier") target = left.text;
    else if (left.type === "member_access_expression" && left.childForFieldName("expression")?.text === "this") {
      target = left.childForFieldName("name")?.text ?? null;
    }
    const entry = target ? fields.get(target) : undefined;
    const right = a.childForFieldName("right");
    if (entry && right) entry.values.push(right);
  }
  for (const { prop, values } of fields.values()) {
    if (values.length === 0) continue;
    let built: string | null = null;
    for (const v of values) {
      const node = unwrapExpression(v);
      const t = node.type === "object_creation_expression" ? node.childForFieldName("type")?.text ?? null : null;
      if (!t || (built !== null && t !== built)) {
        built = null;
        break;
      }
      built = t;
    }
    if (built) prop.type = built;
  }
}

/** A non-interpolated string literal's content, or null. */
function plainString(node: Node): string | null {
  const m = /^@?"((?:[^"\\]|\\.)*)"$/.exec(node.text);
  return m ? m[1]! : null;
}

/**
 * What the class's constructor passes to its base (`: base("v2", httpClient)`
 * → `["v2", "${httpClient}"]`), rendered as `fieldValues` are. Only when
 * every constructor that calls `base(…)` passes the same.
 */
function baseInitializerArgs(body: Node): string[] | null {
  let found: string[] | null = null;
  for (const member of body.namedChildren) {
    if (member.type !== "constructor_declaration") continue;
    const init = member.namedChildren.find((c) => c.type === "constructor_initializer");
    if (!init || init.firstChild?.nextSibling?.type !== "base") continue;
    const list = init.namedChildren.find((c) => c.type === "argument_list");
    const args = (list?.namedChildren ?? []).filter((c) => c.type === "argument").map((arg) => {
      const expr = arg.namedChildren[arg.namedChildren.length - 1];
      if (!expr) return "${}";
      if (expr.type === "string_literal" || expr.type === "verbatim_string_literal") {
        const lit = plainString(expr);
        if (lit !== null) return lit;
      }
      return `\${${expr.text}}`;
    });
    if (found && found.join("\0") !== args.join("\0")) return null;
    found = args;
  }
  return found;
}

/** Parameter name → the DI key it is injected by. */
function keyedParams(params: ParamInfo[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of params) if (p.qualifier) out.set(p.name, p.qualifier);
  return out;
}

/** `_x = x;` / `this._x = x ?? throw …;` in a constructor body, `x` a keyed parameter. */
function noteKeyedAssignments(assignments: Node[], keyed: ReadonlyMap<string, string>, into: Map<string, string | null>): void {
  if (keyed.size === 0) return;
  for (const a of assignments) {
    const left = a.childForFieldName("left");
    const right = a.childForFieldName("right");
    if (!left || !right) continue;
    let field: string | null = null;
    if (left.type === "identifier") field = left.text;
    else if (left.type === "member_access_expression" && left.childForFieldName("expression")?.text === "this") {
      field = left.childForFieldName("name")?.text ?? null;
    }
    const key = keyed.get(storedName(right) ?? "");
    if (field && key) noteKey(into, field, key);
  }
}

/** The parameter an assignment stores: `x`, `(x)`, `x!`, `x ?? throw new …` (a guard, not a fallback). */
function storedName(value: Node): string | null {
  let node = unwrapExpression(value);
  if (node.type === "binary_expression" && node.childForFieldName("right")?.type === "throw_expression") {
    const lhs = node.childForFieldName("left");
    if (!lhs) return null;
    node = unwrapExpression(lhs);
  }
  return node.type === "identifier" ? node.text : null;
}

/** Two different keys stored into one field: neither. */
function noteKey(into: Map<string, string | null>, field: string, key: string): void {
  const prev = into.get(field);
  into.set(field, prev === undefined || prev === key ? key : null);
}

/**
 * A parameter's default (`string tag = "x"`): the grammar names no field for
 * it, so it is the node after the `=`. Older grammars called it `default_value`.
 */
function csharpDefaultValue(p: Node): string | null {
  const field = p.childForFieldName("default_value");
  if (field) return field.text;
  const eq = p.children.findIndex((c) => c.type === "=");
  return eq >= 0 ? p.children[eq + 1]?.text ?? null : null;
}
