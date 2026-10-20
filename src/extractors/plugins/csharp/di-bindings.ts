import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding } from "../../../types/analysis.js";
import { baseTypeTexts } from "./functions-classes.js";
import {
  argumentsOf,
  bareTypeName,
  containerLookup,
  keyText,
  methodNameOf,
  unwrapExpression,
} from "./local-types.js";

/**
 * Container registrations a C# file makes (`meta.ast.diBindings`): what the
 * container builds when a constructor asks for an interface. Only what the
 * registration states — the core decides between several (two unconditional
 * `AddScoped<IShipping, …>` stay undecided, a `TryAdd*` default yields to a
 * real one), so every registration seen is reported.
 *
 * Microsoft.Extensions.DependencyInjection:
 *   `Add{Scoped|Transient|Singleton}<I, T>()`, `TryAdd*` (→ ifAbsent),
 *   `AddKeyed*<I, T>(key)` / `TryAddKeyed*` (→ qualifier, keyedOnly),
 *   `typeof` forms (open generics `typeof(IRepo<>)` → `IRepo`), factories
 *   (`sp => new T(..)`, forwarding `sp => sp.GetRequiredService<T>()`),
 *   instances (`AddSingleton<I>(new T())`), `AddHttpClient<I, T>()`,
 *   `AddDbContext<I, T>()`, `services.Add/TryAdd/Replace(ServiceDescriptor…)`,
 *   Scrutor `Decorate<I, D>()`. Any receiver (`services`, `builder.Services`,
 *   an extension method's `this IServiceCollection`).
 * Autofac: `RegisterType<T>()` / `Register(c => new T())` /
 *   `RegisterInstance(new T())` / `RegisterGeneric(typeof(T<>))` chained into
 *   `.As<I>()`, `.AsImplementedInterfaces()` (the interfaces T's declaration
 *   in THIS file names), `.Keyed<I>(k)` / `.Named<I>(n)`,
 *   `.PreserveExistingDefaults()` / `.IfNotRegistered(..)` (→ ifAbsent);
 *   `RegisterDecorator<D, I>()`.
 * Two-type-argument registrations of Simple Injector / Unity / DryIoc /
 *   LightInject (`container.Register<I, T>()`, `RegisterType<I, T>("name")`,
 *   `RegisterSingleton<I, T>()`) and their single-type-argument factory /
 *   instance forms (`Register<I>(() => new T())`, `RegisterInstance<I>(new T())`).
 *
 * Not reported: self registrations (`AddScoped<T>()`, `RegisterType<T>()` with
 * no service) add nothing; assembly scanning (`RegisterAssemblyTypes`,
 * Scrutor `Scan`) is not statically knowable.
 */

/** Cheap whole-text gate before walking any call. */
const DI_GATE_RE =
  /\b(?:Try)?Add(?:Keyed)?(?:Scoped|Transient|Singleton)\b|\bAddHttpClient\b|\bAddDbContext(?:Pool)?\b|\bServiceDescriptor\b|\bDecorate\s*<|\bRegister(?:Type|Instance|Generic|Singleton|Scoped|Transient|Delegate|Factory|Decorator)?\s*[<(]/;

/** `AddScoped`, `TryAddKeyedSingleton`, … → [tryAdd, keyed]. */
const MS_LIFETIME_RE = /^(Try)?Add(Keyed)?(?:Scoped|Transient|Singleton)$/;

/** `ServiceDescriptor.Scoped<I, T>()`, `.KeyedSingleton<I>(k, …)`, `.Describe(…)`, `.DescribeKeyed(…)`. */
const DESCRIPTOR_FACTORY_RE = /^(?:(Keyed)?(?:Scoped|Transient|Singleton)|Describe(Keyed)?)$/;

/** Collection methods that take a ServiceDescriptor → ifAbsent. */
const DESCRIPTOR_ADDERS: ReadonlyMap<string, boolean> = new Map([
  ["Add", false], ["TryAdd", true], ["TryAddEnumerable", false], ["Replace", false],
]);

/** Two-type-argument registrations `<TService, TImplementation>` (MS DI extensions with no lifetime in the name). */
const MS_PAIR_METHODS: ReadonlySet<string> = new Set(["AddHttpClient", "AddDbContext", "AddDbContextPool"]);

/** Chain roots of Autofac and the `Register<I, T>()` containers. */
const REGISTER_ROOTS: ReadonlySet<string> = new Set([
  "RegisterType", "Register", "RegisterInstance", "RegisterGeneric",
  "RegisterSingleton", "RegisterScoped", "RegisterTransient", "RegisterDelegate", "RegisterFactory",
]);

/** Interfaces Autofac's `AsImplementedInterfaces()` never exposes. */
const NOT_EXPOSED: ReadonlySet<string> = new Set(["IDisposable", "IAsyncDisposable"]);

/** Factory/instance helpers that construct their type argument. */
const ACTIVATORS: ReadonlySet<string> = new Set(["CreateInstance", "GetServiceOrCreateInstance"]);

export function extractCsharpDiBindings(tree: Tree, sourceText: string): DiBinding[] {
  if (!DI_GATE_RE.test(sourceText)) return [];
  const out: DiBinding[] = [];
  let declared: DeclaredTypes | null = null;
  const declaredTypes = (): DeclaredTypes => (declared ??= collectDeclaredTypes(tree.rootNode));

  for (const inv of tree.rootNode.descendantsOfType("invocation_expression")) {
    const fn = inv.childForFieldName("function");
    const line = inv.startPosition.row + 1;
    const before = out.length;
    if (fn?.type === "generic_name") {
      // A project's own registration helper named for the API it wraps
      // (`AddHttpClient<IPlanClient, PlanClient>(services, "Plan", url)`): the
      // two type arguments are the service and what builds it, as they are
      // on the method it forwards to.
      const m = methodNameOf(fn);
      const lifetime = m ? MS_LIFETIME_RE.exec(m.method) : null;
      if (m?.typeArgs.length === 2 && (MS_PAIR_METHODS.has(m.method) || (lifetime && lifetime[2] == null))) {
        push(out, line, m.method, m.typeArgs[0]!.text, m.typeArgs[1]!.text, { ifAbsent: lifetime?.[1] != null || undefined });
      }
      dropTypeParameters(out, before, inv);
      continue;
    }
    if (fn?.type !== "member_access_expression") continue;
    const m = methodNameOf(fn.childForFieldName("name"));
    if (!m) continue;
    const lifetime = MS_LIFETIME_RE.exec(m.method);
    if (lifetime) {
      msRegistration(out, line, m.method, m.typeArgs, argumentsOf(inv), lifetime[1] != null, lifetime[2] != null);
    } else if (MS_PAIR_METHODS.has(m.method) || m.method === "Decorate") {
      if (m.typeArgs.length === 2) push(out, line, m.method, m.typeArgs[0]!.text, m.typeArgs[1]!.text);
    } else if (DESCRIPTOR_ADDERS.has(m.method)) {
      const args = argumentsOf(inv);
      if (args.length === 1) descriptor(out, line, m.method, args[0]!.expr, DESCRIPTOR_ADDERS.get(m.method)!);
    } else if (m.method === "RegisterDecorator") {
      // Autofac `RegisterDecorator<TDecorator, TService>()`: calls through the
      // service reach the decorator — reported so the core does not skip it.
      if (m.typeArgs.length === 2) push(out, line, m.method, m.typeArgs[1]!.text, m.typeArgs[0]!.text);
    } else if (REGISTER_ROOTS.has(m.method)) {
      registerChain(out, line, inv, m.method, m.typeArgs, declaredTypes);
    }
    dropTypeParameters(out, before, inv);
  }
  return out;
}

/**
 * A generic helper's `AddTransient<BaseConsumer, TConsumer>()` names a type
 * PARAMETER: what it binds is decided by each caller, not stated here.
 */
function dropTypeParameters(out: DiBinding[], before: number, inv: Node): void {
  if (out.length === before) return;
  const params = typeParametersInScope(inv);
  if (params.size === 0) return;
  const kept = out.splice(before).filter((b) => !params.has(b.service) && !params.has(b.implementation));
  out.push(...kept);
}

/** Declarations whose `<T, …>` type parameters are in scope inside them. */
const GENERIC_DECLARATIONS: ReadonlySet<string> = new Set([
  "method_declaration", "local_function_statement", "class_declaration", "struct_declaration",
  "record_declaration", "interface_declaration",
]);

/** The type parameter names of every enclosing generic method/type. */
function typeParametersInScope(node: Node): Set<string> {
  const out = new Set<string>();
  for (let p = node.parent; p; p = p.parent) {
    if (!GENERIC_DECLARATIONS.has(p.type)) continue;
    const list = p.childForFieldName("type_parameters") ?? p.namedChildren.find((c) => c.type === "type_parameter_list");
    for (const tp of list?.namedChildren ?? []) {
      if (tp.type !== "type_parameter") continue;
      const name = tp.childForFieldName("name")?.text ?? tp.namedChildren.find((c) => c.type === "identifier")?.text;
      if (name) out.add(name);
    }
  }
  return out;
}

/**
 * `Add{Lifetime}` / `TryAdd{Lifetime}` / `AddKeyed{Lifetime}` (and the same
 * shapes on `ServiceDescriptor`): generic `<I, T>`, `<I>(factory | instance)`,
 * or `(typeof(I), typeof(T) | factory | instance)`; keyed forms take the key
 * right after the service.
 */
function msRegistration(
  out: DiBinding[], line: number, via: string, typeArgs: Node[],
  args: Array<{ name: string | null; expr: Node }>, ifAbsent: boolean, keyed: boolean,
): void {
  let rest = args.filter((a) => !isLifetimeArg(a.expr));
  let service: string | null;
  if (typeArgs.length > 0) {
    service = typeArgs[0]!.text;
  } else {
    const first = named(rest, "serviceType") ?? rest[0];
    service = first ? typeofType(first.expr) : null;
    rest = rest.filter((a) => a !== first);
  }
  if (!service) return;

  let key: string | undefined;
  if (keyed) {
    const k = named(rest, "serviceKey") ?? rest[0];
    const text = k ? keyText(k.expr) : null;
    if (!text) return;
    key = text;
    rest = rest.filter((a) => a !== k);
  }

  let impl: string | null;
  if (typeArgs.length >= 2) {
    impl = typeArgs[1]!.text;
  } else {
    const source = named(rest, "implementationType") ?? named(rest, "implementationFactory")
      ?? named(rest, "implementationInstance") ?? rest[0];
    if (!source) {
      // `AddScoped<T>()` — a self registration; keyed, it still answers to its key.
      impl = key ? service : null;
    } else {
      impl = typeofType(source.expr) ?? producedType(source.expr);
    }
  }
  if (!impl) return;
  push(out, line, via, service, impl, { qualifier: key, keyedOnly: keyed || undefined, ifAbsent: ifAbsent || undefined });
}

/** `services.Add(ServiceDescriptor.Scoped<I, T>())`, `TryAdd(new ServiceDescriptor(typeof(I), typeof(T), lifetime))`. */
function descriptor(out: DiBinding[], line: number, adder: string, expr: Node, ifAbsent: boolean): void {
  const node = unwrapExpression(expr);
  const via = `${adder}(ServiceDescriptor)`;
  if (node.type === "invocation_expression") {
    const fn = node.childForFieldName("function");
    if (fn?.type !== "member_access_expression") return;
    if (bareTypeName(fn.childForFieldName("expression")?.text ?? "") !== "ServiceDescriptor") return;
    const m = methodNameOf(fn.childForFieldName("name"));
    const kind = m ? DESCRIPTOR_FACTORY_RE.exec(m.method) : null;
    if (!m || !kind) return;
    msRegistration(out, line, via, m.typeArgs, argumentsOf(node), ifAbsent, kind[1] != null || kind[2] != null);
  } else if (node.type === "object_creation_expression") {
    if (bareTypeName(node.childForFieldName("type")?.text ?? "") !== "ServiceDescriptor") return;
    const args = argumentsOf(node);
    // (type, impl|factory, lifetime) / (type, instance) vs the keyed
    // (type, key, impl|factory, lifetime) / (type, key, instance).
    const lifetimeLast = args.length > 0 && isLifetimeArg(args[args.length - 1]!.expr);
    const keyed = args.some((a) => a.name === "serviceKey") || (lifetimeLast ? args.length === 4 : args.length === 3);
    msRegistration(out, line, via, [], args, ifAbsent, keyed);
  }
}

/**
 * A `Register*` chain, read from its root outward:
 * `builder.RegisterType<T>().As<I>().Keyed<J>("k").PreserveExistingDefaults()`.
 * `Register<I, T>()` (Simple Injector, Unity, DryIoc, LightInject) states both
 * types in the root; a string argument there is a registration name.
 */
function registerChain(
  out: DiBinding[], line: number, root: Node, method: string, typeArgs: Node[], declaredTypes: () => DeclaredTypes,
): void {
  const args = argumentsOf(root);
  if (typeArgs.length === 2) {
    const nameArg = named(args, "serviceKey") ?? args.find((a) => a.name === null && isStringLiteral(a.expr));
    const key = nameArg ? keyText(nameArg.expr) ?? undefined : undefined;
    push(out, line, method, typeArgs[0]!.text, typeArgs[1]!.text, { qualifier: key, keyedOnly: key ? true : undefined });
    return;
  }
  // `container.Register(typeof(I), typeof(T))` / Unity `RegisterType(typeof(I), typeof(T))`.
  const t0 = args[0] ? typeofType(args[0].expr) : null;
  const t1 = args[1] ? typeofType(args[1].expr) : null;
  if (typeArgs.length === 0 && t0 && t1) {
    push(out, line, method, t0, t1);
    return;
  }

  // What the root constructs, and the service it exposes when nothing in the
  // chain says otherwise (`Register<I>(c => new T())` → I).
  let impl: string | null = null;
  let defaultService: string | null = null;
  if (method === "RegisterType" || method === "RegisterGeneric") {
    impl = typeArgs[0]?.text ?? t0;
  } else {
    defaultService = typeArgs[0]?.text ?? null;
    impl = args[0] ? producedType(args[0].expr) : null;
  }
  if (!impl) return;

  const services: string[] = [];
  const keyedServices: Array<{ service: string; key: string; via: string }> = [];
  let allInterfaces = false;
  let ifAbsent = false;
  let exposing = method;
  for (let cur = root; ;) {
    const access = cur.parent;
    if (access?.type !== "member_access_expression" || access.childForFieldName("expression")?.id !== cur.id) break;
    const call = access.parent;
    if (call?.type !== "invocation_expression" || call.childForFieldName("function")?.id !== access.id) break;
    const mod = methodNameOf(access.childForFieldName("name"));
    const modArgs = argumentsOf(call);
    switch (mod?.method) {
      case "As":
        for (const t of mod.typeArgs) services.push(t.text);
        for (const a of modArgs) {
          const t = typeofType(a.expr);
          if (t) services.push(t);
        }
        exposing = `${method}.As`;
        break;
      case "AsImplementedInterfaces":
        allInterfaces = true;
        break;
      case "Keyed":
      case "Named": {
        // `.Keyed<I>(key)` / `.Keyed(key, typeof(I))`.
        const service = mod.typeArgs[0]?.text ?? (modArgs[1] ? typeofType(modArgs[1].expr) : null);
        const key = modArgs[0] ? keyText(modArgs[0].expr) : null;
        if (service && key) keyedServices.push({ service, key, via: `${method}.${mod.method}` });
        break;
      }
      case "PreserveExistingDefaults":
      case "IfNotRegistered":
        ifAbsent = true;
        break;
    }
    cur = call;
  }

  if (services.length === 0 && keyedServices.length === 0 && !allInterfaces && defaultService) {
    services.push(defaultService);
  }
  const exposed = new Set(services.map((s) => bareTypeName(s)));
  const emit = (service: string, via: string): void => {
    push(out, line, via, service, impl, { ifAbsent: ifAbsent || undefined });
  };
  for (const service of services) emit(service, exposing);
  if (allInterfaces) {
    const implName = bareTypeName(impl) ?? "";
    if (declaredTypes().declares(implName)) {
      for (const iface of declaredTypes().interfacesOf(implName)) {
        if (exposed.has(bareTypeName(iface))) continue;
        exposed.add(bareTypeName(iface));
        emit(iface, `${method}.AsImplementedInterfaces`);
      }
    } else if (implName) {
      // The class is declared in another file: the linker expands the
      // registration from that declaration.
      const binding: DiBinding = { service: "", implementation: implName, line, via: `${method}.AsImplementedInterfaces`, allInterfaces: true };
      if (ifAbsent) binding.ifAbsent = true;
      out.push(binding);
    }
  }
  for (const k of keyedServices) {
    push(out, line, k.via, k.service, impl, {
      qualifier: k.key,
      keyedOnly: exposed.has(bareTypeName(k.service)) ? undefined : true,
      ifAbsent: ifAbsent || undefined,
    });
  }
}

/**
 * The class a factory or instance argument produces: `new T(..)`, a lambda /
 * anonymous method whose every `return` constructs the same class (or
 * forwards to the container: `sp => sp.GetRequiredService<T>()`), an
 * `ActivatorUtilities.CreateInstance<T>(sp)`. Anything else — a method group,
 * a variable, a body that builds different classes — produces nothing.
 */
function producedType(expr: Node): string | null {
  const node = unwrapExpression(expr);
  if (node.type === "lambda_expression" || node.type === "anonymous_method_expression") {
    const body = node.childForFieldName("body")
      ?? node.namedChildren.find((c) => c.type === "block") ?? null;
    if (!body) return null;
    if (body.type !== "block") return returnedType(body);
    let result: string | null = null;
    for (const ret of body.descendantsOfType("return_statement")) {
      if (!ownsReturn(ret, body)) continue;
      const value = ret.namedChild(0);
      const t = value ? returnedType(value) : null;
      if (!t || (result && bareTypeName(result) !== bareTypeName(t))) return null;
      result = t;
    }
    return result;
  }
  return returnedType(node);
}

/** The class a returned/instance expression is: a construction, a forwarded lookup, `a ? new T() : new T()`. */
function returnedType(expr: Node): string | null {
  let node = unwrapExpression(expr);
  if (node.type === "cast_expression") {
    const value = node.childForFieldName("value");
    if (!value) return null;
    node = unwrapExpression(value);
  }
  switch (node.type) {
    case "object_creation_expression":
      return node.childForFieldName("type")?.text ?? null;
    case "conditional_expression": {
      const a = node.childForFieldName("consequence");
      const b = node.childForFieldName("alternative");
      const ta = a ? returnedType(a) : null;
      const tb = b ? returnedType(b) : null;
      return ta && tb && bareTypeName(ta) === bareTypeName(tb) ? ta : null;
    }
    case "invocation_expression": {
      // A keyed forward has no alias form in a binding — left out.
      const lookup = containerLookup(node);
      if (lookup) return lookup.qualifier ? null : lookup.type;
      const fn = node.childForFieldName("function");
      const m = fn?.type === "member_access_expression" ? methodNameOf(fn.childForFieldName("name")) : null;
      if (m && ACTIVATORS.has(m.method) && m.typeArgs.length === 1) return m.typeArgs[0]!.text;
      return null;
    }
  }
  return null;
}

/** A `return` of the lambda body itself, not of a lambda or local function nested in it. */
function ownsReturn(ret: Node, body: Node): boolean {
  for (let p = ret.parent; p && p.id !== body.id; p = p.parent) {
    if (p.type === "local_function_statement" || p.type === "lambda_expression" || p.type === "anonymous_method_expression") {
      return false;
    }
  }
  return true;
}

/** `typeof(IRepo<>)` → `IRepo<>`. */
function typeofType(expr: Node): string | null {
  const node = unwrapExpression(expr);
  if (node.type !== "typeof_expression") return null;
  return node.childForFieldName("type")?.text ?? null;
}

/** `ServiceLifetime.Scoped` — the descriptor's lifetime argument, not a type or key. */
function isLifetimeArg(expr: Node): boolean {
  const node = unwrapExpression(expr);
  return node.type === "member_access_expression" && bareTypeName(node.childForFieldName("expression")?.text ?? "") === "ServiceLifetime";
}

function isStringLiteral(expr: Node): boolean {
  const t = unwrapExpression(expr).type;
  return t === "string_literal" || t === "verbatim_string_literal" || t === "raw_string_literal";
}

function named<T extends { name: string | null }>(args: T[], name: string): T | undefined {
  return args.find((a) => a.name === name);
}

function push(
  out: DiBinding[], line: number, via: string, serviceText: string, implText: string,
  extra: { qualifier?: string; keyedOnly?: boolean; ifAbsent?: boolean } = {},
): void {
  const service = bareTypeName(serviceText);
  const implementation = bareTypeName(implText);
  if (!service || !implementation) return;
  // A self registration adds nothing — unless it answers to a key.
  if (service === implementation && !extra.qualifier) return;
  const binding: DiBinding = { service, implementation, line, via };
  if (extra.qualifier) binding.qualifier = extra.qualifier;
  if (extra.keyedOnly) binding.keyedOnly = true;
  if (extra.ifAbsent) binding.ifAbsent = true;
  out.push(binding);
}

/** The types this file declares, for `AsImplementedInterfaces()`. */
interface DeclaredTypes {
  /** Does this file declare a class/struct/record named `className`? */
  declares(className: string): boolean;
  interfacesOf(className: string): string[];
}

/**
 * Interfaces a class's OWN declaration in this file names. Every base after
 * the first is an interface (C# allows one base class, first); the first is
 * one when this file declares it as an interface, when the type is a struct
 * (structs have no base class), or when it follows the .NET `I`-prefix
 * convention and this file does not declare it as a class.
 */
function collectDeclaredTypes(root: Node): DeclaredTypes {
  const interfaces = new Set<string>();
  const classes = new Set<string>();
  const decls: Array<{ name: string; struct: boolean; bases: string[] }> = [];
  for (const node of root.descendantsOfType([
    "class_declaration", "struct_declaration", "record_declaration", "interface_declaration",
  ])) {
    const name = node.childForFieldName("name")?.text;
    if (!name) continue;
    if (node.type === "interface_declaration") {
      interfaces.add(name);
      continue;
    }
    classes.add(name);
    const struct = node.type === "struct_declaration"
      || (node.type === "record_declaration" && node.children.some((c) => c.type === "struct"));
    decls.push({ name, struct, bases: baseTypeTexts(node) });
  }
  return {
    declares(className: string): boolean {
      return decls.some((d) => d.name === className);
    },
    interfacesOf(className: string): string[] {
      const out: string[] = [];
      for (const d of decls) {
        if (d.name !== className) continue;
        d.bases.forEach((base, i) => {
          const bare = bareTypeName(base);
          if (!bare || NOT_EXPOSED.has(bare)) return;
          const isInterface = i > 0 || d.struct || interfaces.has(bare) || (/^I[A-Z]/.test(bare) && !classes.has(bare));
          if (isInterface) out.push(base);
        });
      }
      return out;
    },
  };
}
