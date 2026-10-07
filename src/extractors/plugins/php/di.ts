import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding } from "../../../types/analysis.js";

/**
 * Dependency injection in PHP: what a container registration binds, what a
 * service-locator lookup returns, and the types a docblock declares where the
 * code declares none.
 *
 * Registrations (`phpDiBindings`):
 *   Laravel   `$this->app->bind(I::class, Impl::class)` (+ singleton/scoped/
 *             instance, the `*If` defaults, a closure returning `new Impl`),
 *             `$bindings` / `$singletons` provider arrays, contextual
 *             `when(C::class)->needs(I::class)->give(Impl::class)`,
 *             `alias(Impl::class, 'name')`, Laravel 12 `#[Bind(Impl::class)]`
 *             on the interface
 *   Symfony   `$services->set(I::class, Impl::class)`, `->alias(I::class,
 *             Impl::class)`, ContainerBuilder `setAlias`/`register`,
 *             `#[AsAlias(I::class)]` on the implementation
 *   PHP-DI    `[I::class => autowire(Impl::class) | create(…) | get(…) |
 *             factory(fn () => new Impl)]`
 * Lookups (`phpLocatorType`): `app(X::class)`, `resolve(X::class)`,
 * `app()->make(X::class)`, `$this->app->make(X::class)`, `App::make(X::class)`,
 * `$container->get(X::class)` (PSR-11), `(new X)` — and string ids
 * (`app('mailer')`) as a qualifier.
 */

/** Laravel registration methods → whether they only register when absent. */
const LARAVEL_BIND: ReadonlyMap<string, boolean> = new Map([
  ["bind", false], ["singleton", false], ["scoped", false], ["instance", false],
  ["bindIf", true], ["singletonIf", true], ["scopedIf", true],
]);

/** Container lookups by method name. */
const LOOKUP_METHODS: ReadonlySet<string> = new Set(["make", "makeWith", "get", "resolve"]);
/** Global helper functions that resolve from the container. */
const LOOKUP_FUNCTIONS: ReadonlySet<string> = new Set(["app", "resolve"]);
/** PHP-DI definition helpers (`DI\autowire`, `\DI\create`, …). */
const PHP_DI_HELPERS: ReadonlySet<string> = new Set(["autowire", "create", "get", "factory"]);

/** Cheap whole-file gate: any of these must appear before the tree is walked. */
const BINDING_GATE = /->\s*(?:bind|singleton|scoped|instance|alias|setAlias|register|set)\w*\s*\(|::\s*(?:bind|singleton|scoped|instance)\w*\s*\(|\$(?:bindings|singletons)\b|#\[\s*\\?(?:[\w\\]+\\)?(?:AsAlias|Bind)\b|\b(?:autowire|create|factory)\s*\(/;

/** `use App\Repo\SqlRepo as Repo;` → `Repo` → `SqlRepo`, so a registration names the real class. */
export function useAliases(tree: Tree): Map<string, string> {
  const aliases = new Map<string, string>();
  const visit = (n: Node): void => {
    if (n.type === "namespace_use_clause") {
      const alias = n.childForFieldName("alias")?.text
        ?? n.children.find((c) => c.type === "namespace_aliasing_clause" || c.type === "namespace_use_alias_clause")
          ?.children.find((c) => c.type === "name")?.text;
      const target = n.children.find((c) => c.type === "qualified_name" || c.type === "name")?.text;
      if (alias && target) aliases.set(alias, simpleClassName(target));
      return;
    }
    if (n.type === "class_declaration" || n.type === "function_definition") return;
    for (const c of n.children) visit(c);
  };
  visit(tree.rootNode);
  return aliases;
}

/** `\App\Repo\Foo` / `App\Repo\Foo` / `'App\\Repo\\Foo'` → `Foo`. */
export function simpleClassName(text: string): string {
  return text.replace(/^['"]|['"]$/g, "").replace(/\\\\/g, "\\").split("\\").filter(Boolean).pop() ?? "";
}

/**
 * A class reference argument: `Foo::class` → Foo; a string naming a class
 * (`'App\\Foo'`) → Foo; any other string → the string itself as a service id
 * (`'mailer'`), flagged so a caller can tell a type from an id.
 */
function classOrId(node: Node | null | undefined, aliases: ReadonlyMap<string, string>): { name: string; isId: boolean } | null {
  if (!node) return null;
  const n = node.type === "argument" ? node.namedChildren[node.namedChildren.length - 1] ?? null : node;
  if (!n) return null;
  if (n.type === "class_constant_access_expression") {
    const parts = n.namedChildren;
    if (parts.length === 2 && parts[1]!.text === "class") {
      const raw = simpleClassName(parts[0]!.text);
      return raw && raw !== "static" && raw !== "self" ? { name: aliases.get(raw) ?? raw, isId: false } : null;
    }
    return null;
  }
  if (n.type === "string" || n.type === "encapsed_string") {
    const text = (n.children.find((c) => c.type === "string_content" || c.type === "string_value")?.text ?? "").trim();
    if (!text || /[$\s]/.test(text)) return null;
    return /\\/.test(text) ? { name: simpleClassName(text), isId: false } : { name: text, isId: true };
  }
  return null;
}

function argsOf(call: Node): Node[] {
  return (call.childForFieldName("arguments")?.children ?? []).filter((c) => c.type === "argument");
}

/**
 * The class a factory constructs: `new Impl(...)` itself, or a closure /
 * arrow function whose body returns exactly one `new Impl(...)`.
 */
function constructedClass(node: Node | null | undefined, aliases: ReadonlyMap<string, string>): string | null {
  if (!node) return null;
  const n = node.type === "argument" ? node.namedChildren[node.namedChildren.length - 1] ?? null : node;
  if (!n) return null;
  if (n.type === "object_creation_expression") {
    const name = n.children.find((c) => c.type === "name" || c.type === "qualified_name")?.text;
    return name ? aliases.get(simpleClassName(name)) ?? simpleClassName(name) : null;
  }
  if (n.type === "parenthesized_expression") return constructedClass(n.namedChildren[0], aliases);
  if (n.type === "arrow_function") return constructedClass(n.childForFieldName("body"), aliases);
  if (n.type === "anonymous_function" || n.type === "anonymous_function_creation_expression") {
    const body = n.childForFieldName("body");
    const returns: Node[] = [];
    const walk = (x: Node): void => {
      if (x.type === "return_statement") { returns.push(x); return; }
      if (x !== body && (x.type === "anonymous_function" || x.type === "arrow_function" || x.type === "anonymous_function_creation_expression")) return;
      for (const c of x.children) walk(c);
    };
    if (body) walk(body);
    if (returns.length !== 1) return null;
    return constructedClass(returns[0]!.namedChildren[0], aliases);
  }
  return null;
}

/** The implementation an argument names: a class reference, or a factory constructing one. */
function implementationOf(node: Node | null | undefined, aliases: ReadonlyMap<string, string>): string | null {
  const ref = classOrId(node, aliases);
  if (ref && !ref.isId) return ref.name;
  return constructedClass(node, aliases);
}

/** Receiver of a method call as plain text, whitespace removed. */
function receiverText(call: Node): string {
  return (call.childForFieldName("object") ?? call.childForFieldName("scope"))?.text.replace(/\s+/g, "") ?? "";
}

/**
 * Every container registration the file makes. Gated on a cheap substring
 * test so files that register nothing never pay for the walk.
 */
export function phpDiBindings(tree: Tree, sourceText: string): DiBinding[] {
  if (!BINDING_GATE.test(sourceText)) return [];
  const aliases = useAliases(tree);
  // PHP-DI's helpers have common names (`create`, `get`): only read them in a
  // file that uses the library.
  const usesPhpDi = /\bDI\\/.test(sourceText);
  const out: DiBinding[] = [];
  const push = (b: DiBinding): void => {
    if (!b.service || !b.implementation) return;
    if (b.service === b.implementation && !b.qualifier) return;
    out.push(b);
  };
  const line = (n: Node): number => n.startPosition.row + 1;

  const visit = (n: Node): void => {
    switch (n.type) {
      case "member_call_expression":
      case "nullsafe_member_call_expression":
      case "scoped_call_expression":
        callRegistration(n);
        break;
      case "property_declaration":
        providerArrays(n);
        break;
      case "class_declaration":
      case "interface_declaration":
        classAttributes(n);
        break;
      case "array_creation_expression":
        if (usesPhpDi) phpDiDefinitions(n);
        break;
    }
    for (const c of n.children) visit(c);
  };

  /** `bind(I::class, Impl::class)`, contextual chains, aliases, Symfony set/alias. */
  const callRegistration = (n: Node): void => {
    const method = n.childForFieldName("name")?.text ?? "";
    const args = argsOf(n);
    const recv = receiverText(n);

    if (method === "give" && args.length >= 1) {
      // when(C::class)->needs(I::class)->give(Impl::class | fn () => new Impl)
      const needs = n.childForFieldName("object");
      if (needs?.type !== "member_call_expression" || needs.childForFieldName("name")?.text !== "needs") return;
      const when = needs.childForFieldName("object");
      if (when?.type !== "member_call_expression" || when.childForFieldName("name")?.text !== "when") return;
      const service = classOrId(argsOf(needs)[0], aliases);
      const impl = implementationOf(args[0], aliases);
      if (!service || !impl) return;
      for (const consumer of contextualConsumers(argsOf(when)[0], aliases)) {
        push({ service: service.name, implementation: impl, consumer, line: line(n), via: "when/needs/give" });
      }
      return;
    }

    if (LARAVEL_BIND.has(method) && args.length >= 2) {
      if (!isContainerReceiver(n, recv)) return;
      const service = classOrId(args[0], aliases);
      const impl = implementationOf(args[1], aliases);
      if (!service || !impl) return;
      const b: DiBinding = { service: service.name, implementation: impl, line: line(n), via: method };
      if (LARAVEL_BIND.get(method)) b.ifAbsent = true;
      push(b);
      return;
    }

    if ((method === "alias" || method === "setAlias") && args.length >= 2) {
      const first = classOrId(args[0], aliases);
      const second = classOrId(args[1], aliases);
      if (!first || !second) return;
      // Symfony (`$services->alias($id, $target)`, ContainerBuilder::setAlias)
      // points the first at the second; Laravel's `alias($abstract, $alias)`
      // makes the second resolve to the first.
      const symfony = method === "setAlias" || /(?:^|[.>$])services\b|services\(\)$/.test(recv);
      const [service, impl] = symfony ? [first, second] : [second, first];
      // An implementation that is itself an id is an alias chain; core follows it.
      push({ service: service.name, implementation: impl.name, line: line(n), via: method });
      return;
    }

    if ((method === "set" || method === "register" || method === "autowire") && args.length >= 2) {
      // Symfony services configurator / ContainerBuilder: set($id, $class).
      if (!/services|container|builder/i.test(recv)) return;
      const service = classOrId(args[0], aliases);
      const impl = classOrId(args[1], aliases);
      if (!service || !impl || impl.isId) return;
      push({ service: service.name, implementation: impl.name, line: line(n), via: method });
    }
  };

  /** A ServiceProvider's `public $bindings = [I::class => Impl::class]` / `$singletons`. */
  const providerArrays = (n: Node): void => {
    for (const el of n.children.filter((c) => c.type === "property_element")) {
      const name = el.childForFieldName("name")?.text.replace(/^\$/, "") ?? el.text;
      if (!/^\$?(?:bindings|singletons)\b/.test(name)) continue;
      const value = el.childForFieldName("default_value") ?? el.namedChildren.find((c) => c.type === "array_creation_expression");
      const array = value?.type === "array_creation_expression" ? value : value?.namedChildren.find((c) => c.type === "array_creation_expression");
      if (!array) continue;
      for (const item of array.namedChildren.filter((c) => c.type === "array_element_initializer")) {
        const [k, v] = item.namedChildren;
        const service = classOrId(k, aliases);
        const impl = classOrId(v, aliases);
        if (service && impl && !impl.isId) push({ service: service.name, implementation: impl.name, line: line(item), via: `$${name.replace(/^\$/, "")}` });
      }
    }
  };

  /** `#[AsAlias(I::class)]` on an implementation, `#[Bind(Impl::class)]` on an interface. */
  const classAttributes = (n: Node): void => {
    const name = n.childForFieldName("name")?.text;
    if (!name) return;
    for (const attr of attributesOf(n)) {
      const attrName = simpleClassName(attr.children.find((c) => c.type === "name" || c.type === "qualified_name")?.text ?? "");
      const args = (attr.childForFieldName("parameters")?.children ?? []).filter((c) => c.type === "argument");
      if (attrName === "AsAlias" && n.type === "class_declaration") {
        const idArg = args.find((a) => a.childForFieldName("name")?.text === "id") ?? args.find((a) => !a.childForFieldName("name"));
        const id = classOrId(idArg, aliases);
        const service = id?.name ?? soleInterface(n, aliases);
        if (service) push({ service, implementation: name, line: line(attr), via: "#[AsAlias]" });
      } else if (attrName === "Bind" && n.type === "interface_declaration") {
        const impl = classOrId(args.find((a) => !a.childForFieldName("name")), aliases);
        if (impl && !impl.isId) push({ service: name, implementation: impl.name, line: line(attr), via: "#[Bind]" });
      }
    }
  };

  /** PHP-DI definition arrays: `[I::class => autowire(Impl::class)]`. */
  const phpDiDefinitions = (n: Node): void => {
    for (const item of n.namedChildren.filter((c) => c.type === "array_element_initializer")) {
      const [k, v] = item.namedChildren;
      if (!k || !v || v.type !== "function_call_expression") continue;
      const helper = simpleClassName(v.childForFieldName("function")?.text ?? "");
      if (!PHP_DI_HELPERS.has(helper)) continue;
      const service = classOrId(k, aliases);
      if (!service) continue;
      const arg = argsOf(v)[0];
      const impl = helper === "factory" ? constructedClass(arg, aliases) : implementationOf(arg, aliases);
      // `autowire()` / `create()` with no argument build the key itself.
      if (impl) push({ service: service.name, implementation: impl, line: line(item), via: `DI\\${helper}` });
    }
  };

  visit(tree.rootNode);
  return out;
}

/** `when(A::class)` / `when([A::class, B::class])` → the consuming classes. */
function contextualConsumers(arg: Node | undefined, aliases: ReadonlyMap<string, string>): string[] {
  if (!arg) return [];
  const value = arg.namedChildren[arg.namedChildren.length - 1];
  if (value?.type === "array_creation_expression") {
    return value.namedChildren
      .filter((c) => c.type === "array_element_initializer")
      .map((c) => classOrId(c.namedChildren[0], aliases))
      .filter((r): r is { name: string; isId: boolean } => !!r && !r.isId)
      .map((r) => r.name);
  }
  const one = classOrId(arg, aliases);
  return one && !one.isId ? [one.name] : [];
}

/**
 * A Laravel container receiver: `$this->app`, `$app`, `app()`, `$container`,
 * `Container::getInstance()`, the `App` facade. `bind` is also PDO's and
 * Closure's — the receiver keeps those out.
 */
function isContainerReceiver(call: Node, recv: string): boolean {
  if (call.type === "scoped_call_expression") return /^\\?(?:Illuminate\\Support\\Facades\\)?App$/.test(recv);
  return /^(?:\$this->app|\$app|app\(\)|\$this->container|\$container|\\?(?:Illuminate\\Container\\)?Container::getInstance\(\))$/.test(recv);
}

function attributesOf(n: Node): Node[] {
  const out: Node[] = [];
  for (const list of n.children.filter((c) => c.type === "attribute_list")) {
    for (const group of list.children.filter((c) => c.type === "attribute_group")) {
      for (const attr of group.children.filter((c) => c.type === "attribute")) out.push(attr);
    }
  }
  return out;
}

/** The one interface a class implements — what Symfony's argument-less `#[AsAlias]` aliases. */
function soleInterface(cls: Node, aliases: ReadonlyMap<string, string>): string | null {
  const clause = cls.children.find((c) => c.type === "class_interface_clause");
  const names = (clause?.children ?? []).filter((c) => c.type === "name" || c.type === "qualified_name");
  if (names.length !== 1) return null;
  const raw = simpleClassName(names[0]!.text);
  return aliases.get(raw) ?? raw;
}

/**
 * The type a container lookup expression yields: `app(Foo::class)`,
 * `resolve(Foo::class)`, `app()->make(Foo::class)`, `$this->app->make(…)`,
 * `App::make(…)`, `$container->get(Foo::class)`, `(new Foo)`. A string id
 * (`app('mailer')`) yields no type but a qualifier. Null for anything else.
 */
export function phpLocatorType(
  n: Node | null | undefined,
  aliases?: ReadonlyMap<string, string>,
): { type: string; qualifier?: string } | null {
  if (!n) return null;
  const al = aliases ?? EMPTY;
  if (n.type === "parenthesized_expression") return phpLocatorType(n.namedChildren[0], aliases);
  if (n.type === "object_creation_expression") {
    const name = n.children.find((c) => c.type === "name" || c.type === "qualified_name")?.text;
    return name && !/^(?:static|self|parent|class)$/.test(name) ? { type: al.get(simpleClassName(name)) ?? simpleClassName(name) } : null;
  }
  let arg: Node | undefined;
  // Whether the receiver is known to be a container — required before a
  // STRING argument is read as a service id (`$request->get('email')` is not
  // a container lookup; `$container->get(Mailer::class)` is, on any receiver).
  let container = false;
  if (n.type === "function_call_expression") {
    const fn = simpleClassName(n.childForFieldName("function")?.text ?? "");
    if (!LOOKUP_FUNCTIONS.has(fn)) return null;
    arg = argsOf(n)[0];
    container = true;
  } else if (n.type === "member_call_expression" || n.type === "scoped_call_expression") {
    const method = n.childForFieldName("name")?.text ?? "";
    if (!LOOKUP_METHODS.has(method)) return null;
    arg = argsOf(n)[0];
    if (n.type === "scoped_call_expression") {
      if (!/^\\?(?:Illuminate\\Support\\Facades\\)?App$/.test(receiverText(n))) return null;
      container = true;
    } else {
      container = isContainerReceiver(n, receiverText(n));
    }
  } else {
    return null;
  }
  const ref = classOrId(arg, al);
  if (!ref) return null;
  if (ref.isId) return container ? { type: "", qualifier: ref.name } : null;
  return { type: ref.name };
}

const EMPTY: ReadonlyMap<string, string> = new Map();

/** One docblock's type tags: `@var T [$name]`, `@param T $name`, `@property[-read|-write] T $name`. */
export interface DocTypes {
  /** `@var T` with no variable name — applies to the declaration below. */
  varType?: string;
  /** `$name` → T from `@param` / named `@var`. */
  named: Map<string, string>;
  /** `@property T $name` on a class. */
  properties: Map<string, string>;
}

/**
 * Parse the type tags of a `/** … *\/` docblock. Types are kept as written
 * (unions, `?T`, generics) with each member's namespace qualifier dropped —
 * the same normalization native PHP types get.
 */
export function parseDocblock(text: string): DocTypes {
  const out: DocTypes = { named: new Map(), properties: new Map() };
  if (!text.startsWith("/**")) return out;
  const re = /@(var|param|property(?:-read|-write)?)\s+([^\s*]+(?:<[^>]*>)?)(?:\s+(?:\.\.\.)?\$(\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const [, tag, rawType, name] = m;
    const type = normalizeDocType(rawType!);
    if (!type) continue;
    if (tag!.startsWith("property")) {
      if (name) out.properties.set(name, type);
    } else if (name) {
      out.named.set(name, type);
    } else if (tag === "var") {
      out.varType = type;
    }
  }
  return out;
}

function normalizeDocType(raw: string): string {
  if (raw.startsWith("$")) return "";
  return raw
    .split(/([|&])/)
    .map((part) => (part === "|" || part === "&" ? part : part.replace(/^(\??)\\?(?:[\w]+\\)*/, "$1")))
    .join("");
}

/** The docblock directly above `n` (its previous sibling), when there is one. */
export function docblockAbove(n: Node): string | null {
  const prev = n.previousSibling;
  return prev?.type === "comment" && prev.text.startsWith("/**") ? prev.text : null;
}
