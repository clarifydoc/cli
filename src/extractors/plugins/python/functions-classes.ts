import type { Node, Tree } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, ParamInfo, Language } from "../../functions-classes/base.js";
import type { CallInfo, PropertyInfo } from "../../../types/analysis.js";
import { extractCalls } from "../../shared/call-graph.js";
import { scanRequestAccess } from "./request-access.js";
import { pyStringValue } from "./data-sources.js";
import {
  annotatedAliases,
  annotationToken,
  collectInstanceAttributes,
  collectLocalTypes,
  constructorParamAttributes,
  fillParamTypesFromComments,
  injectionToken,
  PY_BUILTIN_CALLS,
  resultChainText,
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
    // A `def` nested in a function (a decorator's `wrapper`, a scheduler's `async def loop()`, a
    // paginating helper) is a function of its own: its calls are in no enclosing body, so without
    // it they were in none. Reported under its own name, never exported.
    if (NESTED_DEF.test(node.text)) this.collectNestedFunctions(node, false, functions);
  }

  /**
   * `inBlock`: below a module-level `if` / `try` / `with` / loop — a `def` there
   * (`if args.compare: def write_pairs(…)`) is a module function, kept as one.
   */
  private collectNestedFunctions(node: Node, inFunction: boolean, functions: FunctionInfo[], inBlock = false): void {
    for (const child of node.namedChildren) {
      const def = child.type === "function_definition" ? child
        : child.type === "decorated_definition" ? child.namedChildren.find((c) => c.type === "function_definition") ?? null : null;
      const cls = child.type === "class_definition" ? child
        : child.type === "decorated_definition" ? child.namedChildren.find((c) => c.type === "class_definition") ?? null : null;
      if (def) {
        if (inFunction || inBlock) {
          const parsed = this.parsePythonFunction(def);
          if (inFunction) parsed.fn.isExported = false;
          if (child !== def) parsed.fn.decorators = child.namedChildren.filter((c) => c.type === "decorator").map((d) => d.text.replace(/^@/, ""));
          functions.push(parsed.fn);
        }
        const body = def.childForFieldName("body");
        if (body) this.collectNestedFunctions(body, true, functions);
      } else if (cls) {
        // A class body's defs are its methods; their bodies hold nested functions again.
        const body = cls.childForFieldName("body");
        if (body) this.collectNestedFunctions(body, false, functions);
      } else {
        this.collectNestedFunctions(child, inFunction, functions, !inFunction && (inBlock || MODULE_BLOCK.test(child.type)));
      }
    }
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    this.extractPythonClasses(node, classes);
    // A class a function builds (a form factory's `class _ClubForm(ClubForm)`) is a class of
    // its own: its methods' calls are in no enclosing body otherwise.
    if (NESTED_CLASS.test(node.text)) this.collectFunctionLocalClasses(node, false, classes);
  }

  private collectFunctionLocalClasses(node: Node, inFunction: boolean, classes: ClassInfo[]): void {
    for (const child of node.namedChildren) {
      const inner = child.type === "decorated_definition" ? child.namedChildren.find((c) => c.type === "function_definition" || c.type === "class_definition") ?? child : child;
      if (inner.type === "function_definition") {
        const body = inner.childForFieldName("body");
        if (body) this.collectFunctionLocalClasses(body, true, classes);
      } else if (inner.type === "class_definition") {
        if (inFunction) {
          const local: ClassInfo[] = [];
          this.extractPythonClass(child, local);
          for (const cls of local) if (cls.methods.length > 0) classes.push(cls);
        }
        // Methods of any class hold function bodies again.
        const body = inner.childForFieldName("body");
        if (body) this.collectFunctionLocalClasses(body, false, classes);
      } else {
        this.collectFunctionLocalClasses(child, inFunction, classes);
      }
    }
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
          // An unannotated pytest fixture is typed by what it returns or yields
          // (`return User()`): what a test receives as the parameter of that name.
          if (!parsed.fn.returnType && decorators.some((d) => FIXTURE_DECORATOR.test(d))) {
            const body = funcDef.childForFieldName("body");
            const made = body ? producedClass(body) : null;
            if (made) parsed.fn.returnType = made;
          }
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

    const body0 = node.childForFieldName("body");
    // Unannotated: the one class every `return` constructs (`return AllRepositories(session)`).
    const returnType = node.childForFieldName("return_type")?.text ?? (body0 ? producedClass(body0, false) : null);
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
    // A URL helper (`def clubs_slug(slug): return f"{prefix}/clubs/{slug}"`): the path it returns,
    // its parameters as `{name}`, a module's value as a `${…}` hole.
    const template = body ? returnedUrl(body) : null;
    if (template) fn.urlTemplate = template;
    // A dependency factory (`return _get_current_user if required else _get_optional`): what
    // it hands out is called by whoever asked for it — FastAPI's `Depends(get_authorizer())`.
    if (body && /\breturn\b/.test(bodyText)) {
      for (const returned of returnedModuleFunctions(body)) {
        if (!fn.calls.some((c) => c.name === returned.name)) fn.calls.push({ name: returned.name, kind: "internal", target: null, line: returned.line });
      }
    }
    // A FastAPI dependency's own dependencies (`article = Depends(get_article_by_slug_from_path)`):
    // the framework calls each before the body runs, handing it the route's parameters by name.
    if (paramsNode && DEPENDS_GATE.test(paramsNode.text)) {
      for (const call of signatureDependencyCalls(paramsNode)) {
        if (!fn.calls.some((c) => c.name === call.name && c.line === call.line)) fn.calls.push(call);
      }
    }
    // `*args` / `**kwargs` (bare or annotated) take what the listed parameters do not.
    if (paramsNode?.namedChildren.some((p) => SPLAT_TYPES.has(p.type) || (p.type === "typed_parameter" && SPLAT_TYPES.has(p.namedChild(0)?.type ?? "")))) fn.variadic = true;
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
    for (const child of node.children) this.extractPythonClass(child, classes);
  }

  /** `child` as a class (decorated or not) with the behaviour-bearing classes nested in it; nothing for any other node. */
  private extractPythonClass(child: Node, classes: ClassInfo[]): void {
    {
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
          this.extractNestedPythonClasses(classDef, classes);
        }
      } else if (child.type === "class_definition") {
        classes.push(this.parsePythonClass(child));
        this.extractNestedPythonClasses(child, classes);
      }
    }
  }

  /**
   * A class defined in a class body that has behaviour of its own
   * (`Outer.Inner().go()`). One with no methods — Django's `class Meta`,
   * pydantic's `class Config` — is configuration, not a type anyone calls.
   */
  private extractNestedPythonClasses(owner: Node, classes: ClassInfo[]): void {
    const body = owner.childForFieldName("body");
    if (!body) return;
    const nested: ClassInfo[] = [];
    this.extractPythonClasses(body, nested);
    for (const cls of nested) if (cls.methods.length > 0) classes.push(cls);
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
        properties.push(...propertyMembers(parsed, properties));
        // `def __init__(self, model: type[Club]): self.model = model`: the class an instance
        // holds is the one each construction passes — the project pass reads it there.
        const init = parsed.find((p) => p.fn.name === "__init__");
        const selfName = init ? instanceParam(init) : null;
        // An untyped parameter assigned unchanged (`self.model = model`) may hold a class too: whether it
        // does is for the constructions to say, so the parameter only names the attribute it fills.
        const untyped = init?.fn.params.some((p) => !p.type && !p.name.startsWith("*")) ?? false;
        if (init && selfName && (untyped || properties.some((p) => CLASS_TYPED.test(p.type ?? "")))) {
          const from = constructorParamAttributes({ node: init.node, fn: init.fn, selfName });
          for (const prop of properties) {
            const param = from.get(prop.name);
            if (param && CLASS_TYPED.test(prop.type ?? "")) prop.assignedFrom = param;
          }
          const declared = new Map(properties.map((p) => [p.name, p]));
          for (const [attr, param] of from) {
            const p = init.fn.params.find((x) => x.name === param);
            if (p && !p.type && !declared.get(attr)?.type) p.assignedTo = attr;
          }
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
    // `@abstractmethod`: a member its subclasses supply, and a class that has one is never instantiated.
    for (const m of methods) if (m.decorators.some((d) => ABSTRACT_DECORATOR.test(d))) m.abstract = true;
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
    } else if (methods.some((m) => m.abstract)) {
      cls.abstract = true;
    }
    return cls;
  }
}

/** `@property`, `@cached_property`, `@functools.cached_property`. */
const PROPERTY_DECORATOR = /^(?:functools\.)?(?:cached_)?property$/;

/**
 * A property is a member read like an attribute (`self.repo.page_all()`): typed by
 * its return annotation, by the class it constructs (`return RepositoryFood(…)`,
 * `HttpRepo[…](…)`), by the typed attribute it returns (`return self._repos`), or —
 * when it returns a chain (`return self.repos.ingredient_foods`) — by that chain,
 * left to the project pass (`PropertyInfo.from`).
 */
function propertyMembers(parsed: readonly ParsedFunction[], declared: readonly PropertyInfo[]): PropertyInfo[] {
  const typed = new Map(declared.map((p) => [p.name, p.type]));
  const out: PropertyInfo[] = [];
  for (const p of parsed) {
    if (!p.fn.decorators.some((d) => PROPERTY_DECORATOR.test(d.trim())) || typed.get(p.fn.name)) continue;
    const returned = p.node.childForFieldName("body")?.descendantsOfType("return_statement").filter((r): r is Node => !!r).pop()?.namedChild(0) ?? null;
    let type = p.fn.returnType;
    let from: string | undefined;
    let constructedWith: string[] | undefined;
    if (returned?.type === "call") {
      const callee = returned.childForFieldName("function");
      const name = (callee?.type === "subscript" ? callee.childForFieldName("value") : callee)?.text ?? "";
      if (/^(?:[\w]+\.)*[A-Z]\w*$/.test(name)) {
        const ctor = name.split(".").pop()!;
        type ??= ctor;
        // Annotated as the class it builds (`-> HttpRepo[A, B]` returning `HttpRepo(…)`): its arguments too.
        if (type === ctor || type.replace(/\[[\s\S]*$/, "").split(".").pop() === ctor) {
          const args = returned.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];
          // Positional only: a keyword or a splat would shift every index after it.
          const stop = args.findIndex((a) => a.type === "keyword_argument" || /splat/.test(a.type));
          const positional = stop < 0 ? args : args.slice(0, stop);
          if (positional.length > 0) constructedWith = positional.map((a) => a.text);
        }
      }
    }
    if (!type && returned?.type === "attribute" && /^self\.\w+(?:\.\w+)*$/.test(returned.text)) {
      const own = /^self\.(\w+)$/.exec(returned.text)?.[1];
      type = own ? typed.get(own) ?? null : null;
      if (!type) from = returned.text;
    } else if (!type && returned?.type === "attribute") {
      from = resultChainText(returned) ?? undefined;
    } else if (!type && returned?.type === "call" && returned.childForFieldName("function")?.type === "identifier") {
      // A free function's result (`return get_repositories(self.session)`): typed by what it returns.
      const fn = returned.childForFieldName("function")!.text;
      if (!PY_BUILTIN_CALLS.has(fn)) from = `${fn}()`;
    }
    if (!type && !from) continue;
    const prop: PropertyInfo = { name: p.fn.name, type: type ?? null, visibility: p.fn.name.startsWith("_") ? "private" : "public", isStatic: false, isReadonly: true };
    if (from) prop.from = from;
    if (constructedWith) prop.constructedWith = constructedWith;
    out.push(prop);
  }
  return out;
}

/** A type that holds a class, not an instance: `type[Club]`, `Type[ModelType]`, `typing.Type[T]`. */
const CLASS_TYPED = /^(?:typing\.)?[Tt]ype\s*\[/;

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

const SPLAT_TYPES: ReadonlySet<string> = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);

/** A FastAPI dependency marker or dependency-injector `Provide[…]`, as a default or inside `Annotated[…]`. */
const INJECTION_MARKER_RE = /\b(?:Depends|Security)\s*\(|\bProvide\s*\[/;
const DEPENDS_GATE = /\b(?:Depends|Security)\s*\(/;

/**
 * The calls a signature's `Depends(x)` / `Security(x)` markers make — as a
 * default or in `Annotated[T, Depends(x)]` metadata. A dependency named as a
 * callable is handed the route's parameters by name (`routeParamsByName`); a
 * factory call (`Depends(get_repository(ClubsRepo))`) is a call of the factory.
 */
function signatureDependencyCalls(paramsNode: Node): CallInfo[] {
  const out: CallInfo[] = [];
  const markers: Node[] = [];
  for (const p of paramsNode.namedChildren) {
    const value = p.childForFieldName("value");
    if (value?.type === "call") markers.push(value);
    const generic = p.childForFieldName("type")?.namedChild(0);
    if (generic?.type === "generic_type" && generic.namedChild(0)?.text === "Annotated") {
      for (const m of generic.namedChild(1)?.namedChildren.slice(1) ?? []) {
        const call = m.namedChild(0);
        if (call?.type === "call") markers.push(call);
      }
    }
  }
  for (const marker of markers) {
    const fn = marker.childForFieldName("function");
    const name = fn?.type === "attribute" ? fn.childForFieldName("attribute")?.text : fn?.text;
    if (name !== "Depends" && name !== "Security") continue;
    const dep = marker.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "keyword_argument" && a.type !== "comment");
    if (!dep) continue;
    const named = dep.type === "identifier" || dep.type === "attribute" ? dep : dep.type === "call" ? dep.childForFieldName("function") : null;
    if (!named || (named.type !== "identifier" && named.type !== "attribute")) continue;
    out.push({ name: named.text, kind: "internal", target: null, line: named.startPosition.row + 1, ...(named === dep ? { routeParamsByName: true as const } : {}) });
  }
  return out;
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

/** Cheap gate: some `class` is indented (nested in a class or a function). */
const NESTED_CLASS = /\n[ \t]+class\s+\w/;

/** Module-level statements whose blocks may declare a function (`if __name__ == "__main__":`, `try:`). */
const MODULE_BLOCK = /^(?:if_statement|try_statement|with_statement|for_statement|while_statement|match_statement)$/;

/** Cheap gate: some `def` is indented (a method or a nested function). */
const NESTED_DEF = /\n[ \t]+(?:async[ \t]+)?def[ \t]/;

/** `@pytest.fixture`, `@fixture`, `@pytest.fixture(scope="module")`. */
export const FIXTURE_DECORATOR = /^(?:pytest\.)?fixture\b/;

/**
 * The class a function body hands back: every `return` / `yield` value is a
 * construction of the same class (`User(...)`, `models.User(...)`). Null when
 * they differ or any is something else. Nested functions and classes are not
 * this body.
 */
function producedClass(body: Node, yields = true): string | null {
  const made = new Set<string>();
  let other = false;
  const visit = (n: Node): void => {
    if (n.type === "function_definition" || n.type === "class_definition" || n.type === "lambda") return;
    // A generator returns no instance of what it yields.
    if (n.type === "yield" && !yields) other = true;
    else if (n.type === "return_statement" || n.type === "yield") {
      const value = n.namedChildren[0];
      const callee = value?.type === "call" ? value.childForFieldName("function") : null;
      const name = callee && (callee.type === "identifier" || callee.type === "attribute") ? callee.text : null;
      if (name && /^[A-Z]/.test(name.split(".").pop()!)) made.add(name);
      else if (value) other = true;
      if (!value) return;
    }
    for (const c of n.namedChildren) visit(c);
  };
  visit(body);
  return !other && made.size === 1 ? [...made][0]! : null;
}

/** The module-level function names of a tree, once per tree. */
const moduleFunctionNames = new WeakMap<object, Set<string>>();
function moduleFunctionsOf(root: Node): Set<string> {
  let names = moduleFunctionNames.get(root.tree as unknown as object);
  if (!names) {
    names = new Set();
    for (const child of root.namedChildren) {
      const def = child?.type === "decorated_definition" ? child.childForFieldName("definition") : child;
      if (def?.type === "function_definition") {
        const n = def.childForFieldName("name")?.text;
        if (n) names.add(n);
      }
    }
    moduleFunctionNames.set(root.tree as unknown as object, names);
  }
  return names;
}

/**
 * The module-level functions a body returns by name — `return _get_user`, or
 * either arm of `return _get_user if required else _get_optional_user` — not
 * looking into nested functions.
 */
function returnedModuleFunctions(body: Node): Array<{ name: string; line: number }> {
  const module = moduleFunctionsOf(body.tree.rootNode);
  if (module.size === 0) return [];
  const out: Array<{ name: string; line: number }> = [];
  const names = (e: Node | null): void => {
    if (!e) return;
    if (e.type === "identifier") {
      if (module.has(e.text)) out.push({ name: e.text, line: e.startPosition.row + 1 });
    } else if (e.type === "conditional_expression") {
      const parts = e.namedChildren;
      names(parts[0] ?? null);
      names(parts[2] ?? null);
    } else if (e.type === "parenthesized_expression") names(e.namedChild(0));
  };
  const visit = (n: Node): void => {
    for (const c of n.namedChildren) {
      if (!c || c.type === "function_definition" || c.type === "class_definition" || c.type === "lambda") continue;
      if (c.type === "return_statement") names(c.namedChild(0));
      else visit(c);
    }
  };
  visit(body);
  return out;
}

/** The URL path a body made of one `return` (a docstring before it allowed) hands back, when it has a `/`. */
function returnedUrl(body: Node): string | null {
  const stmts = body.namedChildren.filter((c) => c.type !== "comment" && !(c.type === "expression_statement" && c.namedChild(0)?.type === "string"));
  if (stmts.length !== 1 || stmts[0]!.type !== "return_statement") return null;
  const value = stmts[0]!.namedChild(0);
  const text = value ? pyStringValue(value, value) : null;
  return text && text.includes("/") ? text : null;
}
