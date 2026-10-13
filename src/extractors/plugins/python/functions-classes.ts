import type { Node, Tree } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, Language } from "../../functions-classes/base.js";
import type { PropertyInfo } from "../../../types/analysis.js";
import { extractCalls } from "../../shared/call-graph.js";
import { scanRequestAccess } from "./request-access.js";
import {
  annotatedAliases,
  annotationToken,
  collectInstanceAttributes,
  collectLocalTypes,
  fillParamTypesFromComments,
  injectionToken,
  type MethodSource,
} from "./di.js";

/**
 * Annotated class attributes whose value is an ORM column/relationship call.
 * The entity extractor emits those with the column type it reads from the
 * call (`Integer`, not `Mapped[int]`) and its relations prune navigation
 * fields; emitting them here too would only override its type with the
 * annotation's.
 */
const ORM_FIELD_CALLS = new Set(["mapped_column", "Column", "relationship"]);

/**
 * A body that may type a local: an annotated name, a construction or
 * container lookup assigned, a type comment, a `cast(...)`. Gates the
 * statement walk of `collectLocalTypes`.
 */
const LOCAL_TYPE_GATE = /^\s*[A-Za-z_]\w*\s*:\s*[^\s#]|^\s*[A-Za-z_]\w*\s*=\s*(?:await\s+)?[\w.]+\s*[([]|#\s*type:|\.(?:get|resolve)\s*\(\s*(?:[\w.]+\.)?[A-Z]|ontainer|\bcast\s*\(/m;

/** A body that assigns an instance attribute (`self.x = …`, `self.x: T = …`). */
const SELF_ASSIGN_GATE = /\bself\.\w+\s*(?::[^=\n]*)?=(?!=)/;

/** `@abstractmethod` and its older spellings. */
const ABSTRACT_DECORATOR = /(?:^|\.)abstract(?:method|property|classmethod|staticmethod)\b/;

/** One `def` parsed, with what the class pass needs from it. */
interface ParsedFunction {
  fn: FunctionInfo;
  node: Node;
  /** The body assigns `self.<attr>` somewhere. */
  assignsSelf: boolean;
  /** The body carries `# type:` comments. */
  typeComments: boolean;
}

export class PythonExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["python"];

  /**
   * Module-level `Annotated[...]` aliases of the file being extracted
   * (`RepoDep = Annotated[UserRepo, Depends(get_repo)]`). Set per call of
   * `extractFunctions`/`extractClasses`, which run synchronously per file.
   */
  private aliases: ReadonlyMap<string, string> = new Map();

  override extractFunctions(tree: Tree, sourceText: string): FunctionInfo[] {
    this.aliases = annotatedAliases(tree.rootNode, sourceText);
    try {
      return super.extractFunctions(tree, sourceText);
    } finally {
      this.aliases = new Map();
    }
  }

  override extractClasses(tree: Tree, sourceText: string): ClassInfo[] {
    this.aliases = annotatedAliases(tree.rootNode, sourceText);
    try {
      const classes = super.extractClasses(tree, sourceText);
      if (sourceText.includes(".register(")) applyVirtualSubclasses(tree.rootNode, classes);
      return classes;
    } finally {
      this.aliases = new Map();
    }
  }

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const parsed of this.parseFunctionsIn(node)) functions.push(parsed.fn);
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPythonClasses(node, classes);
  }

  /** The `def`s directly in `node` (a module or a class body), decorated or not. */
  private parseFunctionsIn(node: Node): ParsedFunction[] {
    const out: ParsedFunction[] = [];
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
          const parsed = this.parsePythonFunction(funcDef);
          parsed.fn.decorators = decorators;
          out.push(parsed);
        }
      } else if (child.type === "function_definition") {
        out.push(this.parsePythonFunction(child));
      }
    }
    return out;
  }

  private parsePythonFunction(node: Node): ParsedFunction {
    const name = node.childForFieldName("name")?.text ?? "anonymous";
    const paramsNode = node.childForFieldName("parameters");
    const params: ParamInfo[] = paramsNode ? pythonParams(paramsNode, this.aliases) : [];

    const returnType = node.childForFieldName("return_type")?.text ?? null;
    const isAsync = node.previousSibling?.type === "async" || node.text.startsWith("async ");
    const body = node.childForFieldName("body");
    const bodyText = body?.text ?? "";
    const typeComments = /#\s*type:/.test(bodyText);

    // `# type: (UserRepo) -> None` / a docstring's `:type repo: UserRepo` —
    // the types of parameters the signature leaves unannotated.
    fillParamTypesFromComments(node, body, params);

    const fn: FunctionInfo = {
      name,
      params,
      returnType,
      isAsync,
      isExported: !name.startsWith("_"),
      decorators: [],
      // Stored as returned: core restores held noise calls (`repo.find`) into
      // this very array once the receiver's type is known.
      calls: extractCalls(body, "python"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    // Flask/Django views bind nothing through the signature; what they read
    // off `request` is the only trace of their query/form/body parameters.
    if (body && /\brequest\b/.test(bodyText)) {
      const access = scanRequestAccess(body);
      if (access.length > 0) fn.requestAccess = access;
    }
    if (body && LOCAL_TYPE_GATE.test(bodyText)) {
      const locals = collectLocalTypes(body, params, typeComments);
      if (locals.length > 0) fn.localTypes = locals;
    }
    return { fn, node, assignsSelf: SELF_ASSIGN_GATE.test(bodyText), typeComments };
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
          // `@Iface.register` — an ABC virtual subclass: the class implements
          // Iface without naming it as a base.
          for (const d of decorators) {
            const m = /^((?:\w+\.)*[A-Z]\w*)\.register$/.exec(d.trim());
            if (m && !cls.implements.includes(m[1]!)) cls.implements.push(m[1]!);
          }
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

    // `argument_list`: every positional argument is a base, in MRO order —
    // the first is `extends`, the rest `implements`. `metaclass=` and other
    // keyword arguments are not bases; `*bases` names none statically.
    const baseTexts: string[] = [];
    let metaclass = "";
    for (const c of bases?.namedChildren ?? []) {
      if (c.type === "keyword_argument") {
        if (c.childForFieldName("name")?.text === "metaclass") metaclass = c.childForFieldName("value")?.text ?? "";
      } else if (c.type !== "comment" && c.type !== "list_splat" && c.type !== "dictionary_splat") {
        baseTexts.push(c.text.replace(/\s+/g, " "));
      }
    }

    const body = node.childForFieldName("body");
    const methods: FunctionInfo[] = [];
    const properties: PropertyInfo[] = [];

    // `class Role(str, Enum)` / `class Flags(enum.IntFlag)`: a closed set of
    // named values, whose members are the bare `A = 1` assignments.
    const isEnum = baseTexts.some((t) => /^(?:enum\.)?(?:Enum|IntEnum|StrEnum|Flag|IntFlag)$/.test(t));

    if (body) {
      const parsed = this.parseFunctionsIn(body);
      for (const p of parsed) methods.push(p.fn);
      if (isEnum) collectEnumMembers(body, name, properties);
      else {
        collectAnnotatedAttributes(body, properties);
        // `self.repo = repo` in `__init__` (or any method): the instance
        // attributes a class-level annotation did not already declare.
        const assigning = parsed.filter((p) => p.assignsSelf);
        if (assigning.length > 0) {
          const declared = new Set(properties.map((p) => p.name));
          const sources: MethodSource[] = assigning.map((p) => ({ node: p.node, fn: p.fn, selfName: instanceParam(p) }));
          properties.push(...collectInstanceAttributes(sources, declared, assigning.some((p) => p.typeComments)));
        }
      }
    }

    const cls: ClassInfo = {
      name,
      extends: baseTexts[0] ?? null,
      implements: baseTexts.slice(1),
      decorators: [],
      methods,
      properties,
      isExported: !name.startsWith("_"),
      line: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    };
    if (isEnum) cls.kind = "enum";
    else if (baseTexts.some((t) => /^(?:typing(?:_extensions)?\.)?Protocol(?:\s*\[.*\])?$/s.test(t))) {
      // PEP 544: a Protocol is implemented by having its methods, never by
      // naming it.
      cls.kind = "interface";
      cls.structural = true;
    } else if (
      (baseTexts.some((t) => /^(?:abc\.)?ABC$/.test(t)) || /^(?:abc\.)?ABCMeta$/.test(metaclass.trim())) &&
      methods.some((m) => m.decorators.some((d) => ABSTRACT_DECORATOR.test(d)))
    ) {
      // An abstract base class with abstract members cannot be instantiated:
      // a value typed by it is always one of its subclasses. (An ABC with no
      // abstract member is an ordinary, instantiable base class.)
      cls.kind = "interface";
    }
    return cls;
  }
}

/** The instance parameter of a method (`self`), or null for a static/class method. */
function instanceParam(p: ParsedFunction): string | null {
  if (p.fn.decorators.some((d) => /^(?:staticmethod|classmethod)$/.test(d.trim()))) return null;
  const first = p.node.childForFieldName("parameters")?.namedChild(0);
  return first?.type === "identifier" ? first.text : null;
}

/**
 * `Iface.register(Impl)` statements: an ABC virtual subclass registration.
 * Only an `Iface` this file declares as an interface counts — the same call
 * shape is also a plugin registry's `Registry.register(Plugin)` — and only an
 * `Impl` declared here can carry it.
 */
function applyVirtualSubclasses(root: Node, classes: ClassInfo[]): void {
  const byName = new Map(classes.map((c) => [c.name, c]));
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "expression_statement") continue;
    const call = stmt.namedChild(0);
    if (call?.type !== "call") continue;
    const fn = call.childForFieldName("function");
    if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "register") continue;
    const iface = byName.get(fn.childForFieldName("object")?.text ?? "");
    if (iface?.kind !== "interface") continue;
    const args = call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
    const impl = args.length === 1 ? byName.get(args[0]!.text) : undefined;
    if (impl && impl !== iface && !impl.implements.includes(iface.name)) impl.implements.push(iface.name);
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
function pythonParams(paramsNode: Node, aliases: ReadonlyMap<string, string>): ParamInfo[] {
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
    let type = p.childForFieldName("type")?.text ?? null;
    // `repo: RepoDep` where the module declares `RepoDep = Annotated[UserRepo,
    // Depends(get_repo)]`: the parameter's type is what the alias stands for.
    if (type && aliases.has(type.trim())) type = aliases.get(type.trim())!;
    const defaultValue = p.childForFieldName("value")?.text ?? null;
    const param: ParamInfo = { name, type, defaultValue };
    // The token a container injects it by: `= Depends(get_repo)`,
    // `= Provide[Container.repo]`, or the same marker inside `Annotated[...]`.
    const token = (defaultValue ? injectionToken(defaultValue) : null) ?? (type ? annotationToken(type) : null);
    if (token) param.qualifier = token;
    // `Depends()` / `Security()` with no dependency, or a class as the
    // dependency: the container still supplies the parameter (its annotated
    // class is resolved), so registrations decide it.
    else if (INJECTION_MARKER_RE.test(defaultValue ?? "") || INJECTION_MARKER_RE.test(type ?? "")) param.injected = true;
    params.push(param);
  }
  return params;
}

/** A FastAPI dependency marker or dependency-injector `Provide[…]`, as a default or inside `Annotated[…]`. */
const INJECTION_MARKER_RE = /\b(?:Depends|Security)\s*\(|\bProvide\s*\[/;

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
