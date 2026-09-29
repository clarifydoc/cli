import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, Language } from "../../functions-classes/base.js";
import type { PropertyInfo } from "../../../types/analysis.js";
import { extractCalls } from "../../shared/call-graph.js";
import { scanRequestAccess } from "./request-access.js";

/**
 * Annotated class attributes whose value is an ORM column/relationship call.
 * The entity extractor emits those with the column type it reads from the
 * call (`Integer`, not `Mapped[int]`) and its relations prune navigation
 * fields; emitting them here too would only override its type with the
 * annotation's.
 */
const ORM_FIELD_CALLS = new Set(["mapped_column", "Column", "relationship"]);

export class PythonExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["python"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    this.extractPythonFunctions(node, functions);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPythonClasses(node, classes);
  }

  private extractPythonFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.children) {

      if (child.type === "decorated_definition") {
        const decorators: string[] = [];
        let funcDef: Node | null = null;
        for (const part of child.children) {
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
    const params: ParamInfo[] = paramsNode ? pythonParams(paramsNode) : [];

    const returnType = node.childForFieldName("return_type")?.text ?? null;
    const isAsync = node.previousSibling?.type === "async" || node.text.startsWith("async ");
    const body = node.childForFieldName("body");

    const fn: FunctionInfo = {
      name,
      params,
      returnType,
      isAsync,
      isExported: !name.startsWith("_"),
      decorators: [],
      calls: extractCalls(body, "python"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    // Flask/Django views bind nothing through the signature; what they read
    // off `request` is the only trace of their query/form/body parameters.
    if (body && /\brequest\b/.test(body.text)) {
      const access = scanRequestAccess(body);
      if (access.length > 0) fn.requestAccess = access;
    }
    return fn;
  }

  private extractPythonClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.children) {

      if (child.type === "decorated_definition") {
        const decorators: string[] = [];
        let classDef: Node | null = null;
        for (const part of child.children) {
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

    // `argument_list`: child(0) is the `(` token; the first NAMED child is the
    // base. `metaclass=` keyword arguments are not bases.
    const firstBase = bases?.namedChildren.find((c) => c.type !== "keyword_argument" && c.type !== "comment");
    if (firstBase) extendsName = firstBase.text;

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    // `class Role(str, Enum)` / `class Flags(enum.IntFlag)`: a closed set of
    // named values, whose members are the bare `A = 1` assignments.
    const isEnum = (bases?.namedChildren ?? []).some((c) => /^(?:enum\.)?(?:Enum|IntEnum|StrEnum|Flag|IntFlag)$/.test(c.text));

    if (body) {
      this.extractPythonFunctions(body, methods);
      if (isEnum) collectEnumMembers(body, name, properties);
      else collectAnnotatedAttributes(body, properties);
    }

    const cls: ClassInfo = {
      name,
      extends: extendsName,
      implements: [],
      decorators: [],
      methods,
      properties,
      isExported: !name.startsWith("_"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    if (isEnum) cls.kind = "enum";
    return cls;
  }
}

/**
 * Parameters of a `def`. tree-sitter-python has four shapes: a bare
 * `identifier`, `typed_parameter` (its name is the first identifier child —
 * there is no `name` field), `default_parameter(name, value)` and
 * `typed_default_parameter(name, type, value)`. `self`/`cls`, the `*` / `/`
 * separators and `*args` / `**kwargs` are not parameters a caller passes by
 * name.
 */
function pythonParams(paramsNode: Node): ParamInfo[] {
  const params: ParamInfo[] = [];
  for (const p of paramsNode.namedChildren) {
    let name: string | null = null;
    switch (p.type) {
      case "identifier":
        name = p.text;
        break;
      case "typed_parameter": {
        // `*args: int` / `**kw: str` start with a splat pattern, not a name.
        const first = p.namedChild(0);
        name = first?.type === "identifier" ? first.text : null;
        break;
      }
      case "default_parameter":
      case "typed_default_parameter":
        name = p.childForFieldName("name")?.text ?? null;
        break;
      default:
        continue;
    }
    if (!name || name === "self" || name === "cls") continue;
    params.push({
      name,
      type: p.childForFieldName("type")?.text ?? null,
      defaultValue: p.childForFieldName("value")?.text ?? null,
    });
  }
  return params;
}

/**
 * Annotated class attributes — `name: str = Field(..., alias="user_name")` —
 * are the fields of a Pydantic model, a dataclass, a TypedDict or an attrs
 * class; unannotated assignments (`x = 1`, `model_config = …`) are class
 * variables and stay out. A `Field(...)` value is kept verbatim in
 * `decorators` so the request-schema hooks can read `alias=` from it.
 */
function collectAnnotatedAttributes(body: Node, properties: PropertyInfo[]): void {
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assignment = stmt.namedChild(0);
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const type = assignment.childForFieldName("type");
    if (left?.type !== "identifier" || !type) continue;
    const right = assignment.childForFieldName("right");
    if (right && isOrmFieldCall(right)) continue;

    const name = left.text;
    const typeText = type.text.replace(/\s+/g, " ");
    const prop: PropertyInfo = {
      name,
      type: typeText,
      visibility: name.startsWith("_") ? "private" : "public",
      isStatic: /^(?:typing\.)?ClassVar\b/.test(typeText),
      isReadonly: /^(?:typing\.)?Final\b/.test(typeText),
    };
    const field = right && isFieldCall(right) ? right : null;
    if (field) prop.decorators = [field.text.replace(/\s+/g, " ")];
    prop.isRequired = isRequiredAttribute(typeText, right, field);
    properties.push(prop);
  }
}

function callName(node: Node): string | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type === "identifier") return fn.text;
  if (fn?.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
  return null;
}

function isOrmFieldCall(node: Node): boolean {
  const name = callName(node);
  return name !== null && ORM_FIELD_CALLS.has(name);
}

/** Pydantic `Field(...)` and dataclass `field(...)`. */
function isFieldCall(node: Node): boolean {
  const name = callName(node);
  return name === "Field" || name === "field";
}

/**
 * Pydantic's rule: a field is required when it has no default. `Field(...)`
 * counts as no default unless it carries one — a first positional other than
 * `...`, or `default=` / `default_factory=`. `Optional[X]` / `X | None` with
 * no default is still required in v2 (a value must be sent, it may be null),
 * but that is the one place v1 and the reader's intuition disagree, so it is
 * read as optional — the schema marks it nullable either way.
 */
function isRequiredAttribute(typeText: string, right: Node | null, field: Node | null): boolean {
  if (!right) return !isNullableType(typeText);
  if (!field) return false;
  const args = field.childForFieldName("arguments");
  for (const arg of args?.namedChildren ?? []) {
    if (arg.type === "keyword_argument") {
      const key = arg.childForFieldName("name")?.text;
      if (key === "default" || key === "default_factory") return false;
    } else if (arg.type !== "comment") {
      return arg.type === "ellipsis";
    }
  }
  return true;
}

function isNullableType(typeText: string): boolean {
  return /^(?:typing\.)?Optional\s*\[/.test(typeText)
    || /\|\s*None\b|\bNone\s*\|/.test(typeText)
    || /^(?:typing\.)?Union\s*\[[^\]]*\bNone\b/.test(typeText);
}

/** Enum members: `GUEST = "guest"` assignments directly in the class body. */
function collectEnumMembers(body: Node, enumName: string, out: PropertyInfo[]): void {
  for (const stmt of body.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const assign = stmt.namedChildren[0];
    if (!assign || assign.type !== "assignment") continue;
    const left = assign.childForFieldName("left");
    if (!left || left.type !== "identifier" || left.text.startsWith("_")) continue;
    out.push({ name: left.text, type: enumName, visibility: "public", isStatic: true, isReadonly: true });
  }
}
