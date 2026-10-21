import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding } from "../../../types/analysis.js";
import { isBuiltinType } from "../../shared/builtin-types.js";
import {
  annotationArgIs,
  annotationName,
  annotationNodes,
  annotationValues,
  classRefName,
  decapitalize,
  expressionValues,
  simpleName,
} from "./di-annotations.js";
import {
  callArguments,
  calleeOrMethodName,
  expressionFact,
  guiceKey,
  guiceQualifier,
  koinQualifier,
  type ExprFact,
} from "./di-expressions.js";
import { jvmSupertypes, lastExpressionFact } from "./functions-classes.js";

/**
 * Container registrations a Java/Kotlin file makes (`meta.ast.diBindings`) —
 * what the container builds when an injection point asks for a type. Only
 * what the source states; every registration seen is reported and the core
 * decides between several (two `@Component`s of one interface stay
 * undecided unless `@Primary` or the injected member's name picks one).
 *
 * Spring   stereotype classes (`@Component` `@Service` `@Repository`
 *          `@Controller` `@RestController` `@Configuration`
 *          `@ControllerAdvice` `@RestControllerAdvice`) → one binding per
 *          implemented interface, named by the bean name (`@Service("x")`,
 *          else the decapitalized class name), `@Primary`, class-level
 *          `@Qualifier("q")`; `@Bean` methods (one binding per name,
 *          `@ConditionalOnMissingBean` → a default that yields).
 * Guice    `bind(I.class).to(Impl.class)` / `.annotatedWith(Names.named("x")
 *          | Q.class)` / `.toInstance(new Impl())` (also on `binder()`, and
 *          kotlin-guice `bind<I>().to<Impl>()`); `@ImplementedBy(Impl.class)`
 *          (a default); `@Provides` methods.
 * Dagger / Hilt  `@Binds` (`abstract I bind(Impl impl)`), `@Provides`.
 * CDI      bean-defining classes (`@ApplicationScoped` `@RequestScoped`
 *          `@SessionScoped` `@ConversationScoped` `@Dependent` `@Model`,
 *          or `@Named`) → one binding per implemented interface, named by
 *          `@Named`; `@Alternative` + `@Priority` → primary; `@Produces`.
 * Koin     inside `module { … }`: `single<I> { Impl(get()) }` / `factory` /
 *          `scoped` / `viewModel` / `worker`, `named("x")` keys,
 *          `singleOf(::Impl) { bind<I>(); named("x") }`, infix `bind I::class`
 *          / `binds arrayOf(…)` / `withOptions { … }`; Koin Annotations
 *          `@Single` / `@Factory` / `@KoinViewModel` classes.
 *
 * A provider method (`@Bean`, `@Provides`, `@Produces`, a Koin definition
 * with a type argument) registers the class its body returns — the one
 * construction (`return new Impl(..)`, Kotlin `= Impl(..)`) or the parameter
 * it hands back (`return impl;`); when the body says neither, it registers
 * its declared type itself, so the registration still COMPETES with the
 * others for that type (a `@Bean Notifier sms()` next to a `@Component
 * MailNotifier` leaves `Notifier` undecided, as Spring does) — on an
 * interface that resolves to the interface's own method, never to a guess.
 *
 * Not reported: a superclass as a Spring/CDI service (core would treat the
 * subclass as the only bean of the base type, though the base class may be a
 * bean itself); `@Singleton`-only classes (Dagger shares the annotation and
 * binds nothing implicitly); multibindings (`@IntoSet`, `@IntoMap`, Guice
 * `Multibinder`); `toProvider(..)`; Koin constructor arguments chosen at the
 * module (`Svc(get(named("x")))`).
 */

type JkLang = "java" | "kotlin";

/** Cheap whole-text gate before walking anything. */
const DI_GATE_RE =
  /@(?:Component|Service|Repository|Controller|RestController|Configuration|ControllerAdvice|RestControllerAdvice|Bean|Provides|Binds|Produces|ImplementedBy|ApplicationScoped|RequestScoped|SessionScoped|ConversationScoped|Dependent|Model|Named|Single|Factory|KoinViewModel|KoinWorker)\b|\bbind\s*[(<]|\bmodule\s*(?:\([^)]*\)\s*)?\{/;

const SPRING_STEREOTYPES: ReadonlySet<string> = new Set([
  "Component", "Service", "Repository", "Controller", "RestController", "Configuration",
  "ControllerAdvice", "RestControllerAdvice",
]);

const CDI_BEAN_DEFINING: ReadonlySet<string> = new Set([
  "ApplicationScoped", "RequestScoped", "SessionScoped", "ConversationScoped", "Dependent", "Model",
]);

/** Koin Annotations definitions (Kotlin). */
const KOIN_ANNOTATIONS: ReadonlySet<string> = new Set(["Single", "Factory", "KoinViewModel", "KoinWorker"]);

/** Multibinding contributions: they do not bind the plain key. */
const MULTIBINDINGS: ReadonlySet<string> = new Set(["IntoSet", "IntoMap", "ElementsIntoSet", "Multibinds", "BindsOptionalOf"]);

/**
 * Annotations on a `@Provides`/`@Binds`/`@Produces` method that are not a
 * binding key. Anything else there is taken as a custom qualifier annotation
 * (`@Provides @IoDispatcher …`), which makes the binding keyed-only — a scope
 * spelled `*Scope`/`*Scoped`/`Per*` is recognised by name.
 */
const PROVIDER_NON_QUALIFIERS: ReadonlySet<string> = new Set([
  "Provides", "Binds", "Produces", "Bean", "Singleton", "Reusable", "Dependent", "Override", "JvmStatic", "JvmName",
  "Exposed", "Nullable", "NonNull", "Nonnull", "CheckReturnValue", "VisibleForTesting", "Deprecated", "Suppress",
  "SuppressWarnings", "Alternative", "Priority", "Typed", "Default", "Any", "Disposes", "Primary", "Lazy",
  "Transactional", "Timed", "Counted", "Metered", "Traced", "WithSpan", "Synchronized", "Throws",
]);

const SCOPE_LIKE_RE = /(?:Scope|Scoped)$|^Per[A-Z]/;

/** Koin definition DSL functions. */
const KOIN_DEFINITIONS: ReadonlySet<string> = new Set(["single", "factory", "scoped", "viewModel", "worker", "fragment"]);
const KOIN_CONSTRUCTOR_DSL: ReadonlySet<string> = new Set(["singleOf", "factoryOf", "scopedOf", "viewModelOf", "workerOf", "fragmentOf"]);

export function extractJvmDiBindings(tree: Tree, sourceText: string, language: JkLang): DiBinding[] {
  if (!DI_GATE_RE.test(sourceText)) return [];
  const out: DiBinding[] = [];
  const ctx: Ctx = {
    lang: language,
    out,
    guice: /\bbind\s*[(<]/.test(sourceText),
    koin: language === "kotlin" && /\bmodule\s*(?:\([^)]*\)\s*)?\{/.test(sourceText),
  };
  visitDeclarations(tree.rootNode, ctx);
  return out;
}

interface Ctx {
  lang: JkLang;
  out: DiBinding[];
  /** The file spells a `bind(` — scan method bodies for Guice chains. */
  guice: boolean;
  /** The file spells `module {` — scan for Koin modules. */
  koin: boolean;
}

const CLASS_LIKE: ReadonlySet<string> = new Set([
  "class_declaration", "interface_declaration", "record_declaration", "enum_declaration", "object_declaration",
]);
const BODY_TYPES: ReadonlySet<string> = new Set([
  "class_body", "interface_body", "enum_body", "enum_class_body", "enum_body_declarations",
]);

/** Walk declarations (program → classes → nested classes / members); bodies only when a scan needs them. */
function visitDeclarations(node: Node, ctx: Ctx): void {
  for (const child of node.children) {
    const t = child.type;
    if (CLASS_LIKE.has(t)) {
      classBindings(child, ctx);
      const body = child.childForFieldName("body") ?? child.children.find((c) => BODY_TYPES.has(c.type));
      if (body) visitDeclarations(body, ctx);
    } else if (BODY_TYPES.has(t) || t === "companion_object" || t === "program" || t === "source_file") {
      visitDeclarations(child, ctx);
    } else if (t === "method_declaration" || t === "function_declaration") {
      providerBindings(child, ctx);
      if (ctx.guice || ctx.koin) scanBody(child, ctx);
    } else if (t === "property_declaration" || t === "field_declaration") {
      if (ctx.koin) scanBody(child, ctx);
    }
  }
}

// ─── Class-level registrations ───────────────────────────────────────────

function classBindings(node: Node, ctx: Ctx): void {
  const anns = annotationNodes(node);
  if (anns.length === 0) return;
  const byName = new Map<string, Node>();
  for (const a of anns) {
    const n = annotationName(a);
    if (n && !byName.has(n)) byName.set(n, a);
  }
  const className = node.childForFieldName("name")?.text ?? node.children.find((c) => c.type === "type_identifier" || c.type === "simple_identifier")?.text;
  if (!className) return;
  const line = node.startPosition.row + 1;
  const isInterface = node.type === "interface_declaration" || node.children.some((c) => c.type === "interface");

  if (isInterface) {
    // Guice `@ImplementedBy(Impl.class)`: used only when nothing binds the interface explicitly.
    const ib = byName.get("ImplementedBy");
    const impl = ib ? annotationValues(ib, ["value"])?.[0] : undefined;
    if (impl && impl !== className) {
      ctx.out.push({ service: className, implementation: impl, line, via: "@ImplementedBy", ifAbsent: true });
    }
    return;
  }
  if (node.type === "enum_declaration" || node.type === "object_declaration" || isAbstract(node)) return;

  const { implementsList, extendsName } = jvmSupertypes(node);
  const services = [...new Set(implementsList.map((s) => simpleName(s)).filter((s): s is string => !!s && s !== className))];

  const stereotype = [...byName.keys()].find((n) => SPRING_STEREOTYPES.has(n));
  if (stereotype) {
    // A bean is registered under every interface it has, inherited ones too:
    // `class Impl extends AbstractBase` answers what the base implements —
    // which only the core sees (`allInterfaces`).
    const inherits = !!extendsName && simpleName(extendsName) !== className;
    if (services.length === 0 && !inherits) return;
    // Bean name: `@Service("x")` / `@Component(value = "x")` / a JSR-330 `@Named("x")`, else the decapitalized class name.
    const explicit =
      annotationValues(byName.get(stereotype)!, ["value"])?.[0] ??
      (byName.has("Named") ? annotationValues(byName.get("Named")!, ["value"])?.[0] : undefined);
    const beanName = explicit || decapitalize(className);
    const primary = byName.has("Primary");
    const qualifierAnn = byName.get("Qualifier");
    const extra = qualifierAnn ? annotationValues(qualifierAnn, ["value"])?.[0] : undefined;
    for (const service of inherits ? [...services, ""] : services) {
      const b: DiBinding = { service, implementation: className, line, via: `@${stereotype}`, qualifier: beanName, matchesMemberName: true };
      if (!service) b.allInterfaces = true;
      if (primary) b.primary = true;
      ctx.out.push(b);
      if (extra && extra !== beanName) {
        const q: DiBinding = { service, implementation: className, line, via: "@Qualifier", qualifier: extra };
        if (!service) q.allInterfaces = true;
        if (primary) q.primary = true;
        ctx.out.push(q);
      }
    }
    return;
  }

  // Koin Annotations (Kotlin) — checked before CDI: Koin has its own `@Named`.
  const koin = ctx.lang === "kotlin" ? [...byName.keys()].find((n) => KOIN_ANNOTATIONS.has(n)) : undefined;
  if (koin) {
    // `@Single(binds = [I::class])` lists its services; otherwise the declared supertypes.
    const declared = annotationValues(byName.get(koin)!, ["binds"], false);
    const koinServices = declared ? declared.filter((s) => s !== className) : services;
    const named = byName.get("Named");
    const key = named ? annotationValues(named, ["value"])?.[0] : undefined;
    for (const service of koinServices) {
      const b: DiBinding = { service, implementation: className, line, via: `@${koin}` };
      if (key) { b.qualifier = key; b.keyedOnly = true; }
      ctx.out.push(b);
    }
    return;
  }

  const cdi = [...byName.keys()].find((n) => CDI_BEAN_DEFINING.has(n)) ?? (byName.has("Named") ? "Named" : undefined);
  if (cdi) {
    if (services.length === 0) return;
    // `@Named("x")` names the bean; a bare `@Named` (and `@Model`) the decapitalized class name.
    const named = byName.get("Named");
    const beanName = named
      ? annotationValues(named, ["value"])?.[0] || decapitalize(className)
      : cdi === "Model" ? decapitalize(className) : undefined;
    // An enabled alternative (`@Alternative @Priority(n)`) wins; one without a
    // priority is switched on by beans.xml or not at all — reported as a plain
    // registration, so the choice stays undecided.
    const primary = byName.has("Alternative") && byName.has("Priority");
    for (const service of services) {
      const b: DiBinding = { service, implementation: className, line, via: `@${cdi}` };
      if (beanName) b.qualifier = beanName;
      if (primary) b.primary = true;
      ctx.out.push(b);
    }
    return;
  }
}

function isAbstract(node: Node): boolean {
  const mods = node.children.find((c) => c.type === "modifiers");
  if (!mods) return false;
  for (const m of mods.children) {
    if (m.type === "abstract" || m.text === "abstract" || m.text === "sealed") return true;
  }
  return false;
}

// ─── Provider methods: @Bean / @Provides / @Binds / @Produces ────────────

function providerBindings(fn: Node, ctx: Ctx): void {
  const anns = annotationNodes(fn);
  if (anns.length === 0) return;
  const names = anns.map((a) => annotationName(a) ?? "");
  const kind = names.find((n) => n === "Bean" || n === "Provides" || n === "Binds" || n === "Produces");
  if (!kind) return;
  if (names.some((n) => MULTIBINDINGS.has(n))) return;
  const line = fn.startPosition.row + 1;
  const methodName = fn.childForFieldName("name")?.text ?? fn.children.find((c) => c.type === "simple_identifier")?.text ?? "";
  const declared = returnTypeName(fn, ctx.lang);
  const params = parameterTypes(fn, ctx.lang);

  if (kind === "Binds") {
    // `@Binds abstract I bind(Impl impl)` — the one parameter is the implementation.
    const impl = params.length === 1 ? simpleName(params[0]!.type) : null;
    if (!declared || !impl || impl === declared) return;
    pushKeyed(ctx, { service: declared, implementation: impl, line, via: "@Binds" }, anns, true);
    return;
  }

  const returned = returnedType(fn, ctx.lang, params);
  const service = declared ?? returned;
  if (!service || isBuiltinType(service, ctx.lang)) return;
  const implementation = returned ?? service;

  if (kind === "Bean") {
    const bean = anns[names.indexOf("Bean")]!;
    if (annotationArgIs(bean, "autowireCandidate", "false")) return;
    const beanNames = annotationValues(bean, ["name", "value"]) ?? [];
    const primary = names.includes("Primary");
    const ifAbsent = names.includes("ConditionalOnMissingBean");
    for (const qualifier of beanNames.length > 0 ? beanNames : [methodName]) {
      const b: DiBinding = { service, implementation, line, via: "@Bean", qualifier, matchesMemberName: true };
      if (primary) b.primary = true;
      if (ifAbsent) b.ifAbsent = true;
      ctx.out.push(b);
    }
    const q = anns.find((a) => annotationName(a) === "Qualifier");
    const extra = q ? annotationValues(q, ["value"])?.[0] : undefined;
    if (extra && !beanNames.includes(extra) && extra !== methodName) {
      const b: DiBinding = { service, implementation, line, via: "@Qualifier", qualifier: extra };
      if (primary) b.primary = true;
      ctx.out.push(b);
    }
    return;
  }

  // Guice / Dagger `@Provides` (a `@Named` or custom key makes it keyed-only),
  // CDI `@Produces` (a `@Named` bean keeps the default qualifier; a custom
  // qualifier replaces it).
  pushKeyed(ctx, { service, implementation, line, via: `@${kind}` }, anns, kind === "Provides");
}

/** Add the method-level key (`@Named("x")`, a custom qualifier annotation) and push. */
function pushKeyed(ctx: Ctx, b: DiBinding, anns: Node[], namedIsKeyedOnly: boolean): void {
  for (const a of anns) {
    const n = annotationName(a);
    if (!n) continue;
    if (n === "Named") {
      const v = annotationValues(a, ["value"])?.[0];
      if (v) {
        b.qualifier = v;
        if (namedIsKeyedOnly) b.keyedOnly = true;
      }
      break;
    }
    if (n === "Qualifier") {
      const v = annotationValues(a, ["value"])?.[0];
      if (v) { b.qualifier = v; b.keyedOnly = true; }
      break;
    }
    if (!PROVIDER_NON_QUALIFIERS.has(n) && !SCOPE_LIKE_RE.test(n)) {
      b.qualifier = n;
      b.keyedOnly = true;
      break;
    }
  }
  if (b.service === b.implementation && !b.qualifier && b.via === "@Binds") return;
  ctx.out.push(b);
}

/** Declared return type of a method / function, as a simple name (null for `void`/none). */
function returnTypeName(fn: Node, lang: JkLang): string | null {
  if (lang === "java") {
    const t = fn.childForFieldName("type");
    return t && t.type !== "void_type" ? simpleName(t.text) : null;
  }
  const kids = fn.children;
  const params = kids.findIndex((c) => c.type === "function_value_parameters");
  for (let i = params + 1; params >= 0 && i < kids.length; i++) {
    const k = kids[i]!;
    if (k.type === "function_body") return null;
    if (k.type === ":") {
      const t = kids[i + 1];
      return t ? simpleName(t.text) : null;
    }
  }
  return null;
}

/** Parameters of a method / function: name + declared type text. */
function parameterTypes(fn: Node, lang: JkLang): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  const list = lang === "java"
    ? fn.childForFieldName("parameters")
    : fn.children.find((c) => c.type === "function_value_parameters");
  for (const p of list?.namedChildren ?? []) {
    if (p.type === "formal_parameter") {
      const name = p.childForFieldName("name")?.text;
      const type = p.childForFieldName("type")?.text;
      if (name && type) out.push({ name, type });
    } else if (p.type === "parameter") {
      const name = p.children.find((c) => c.type === "simple_identifier")?.text;
      const type = p.children.find((c) => c.type === "user_type" || c.type === "nullable_type")?.text;
      if (name && type) out.push({ name, type });
    }
  }
  return out;
}

/**
 * The class a provider body returns: the construction of every `return`
 * (all the same class), or the parameter it hands back. Null when the body
 * says anything else (a builder, a factory call, two different classes).
 */
function returnedType(fn: Node, lang: JkLang, params: Array<{ name: string; type: string }>): string | null {
  const exprs: Node[] = [];
  if (lang === "java") {
    const body = fn.childForFieldName("body");
    if (!body) return null;
    collectReturns(body, exprs, "return_statement", JAVA_RETURN_BARRIERS);
  } else {
    const body = fn.children.find((c) => c.type === "function_body");
    if (!body) return null;
    const eq = body.children.findIndex((c) => c.type === "=");
    if (eq >= 0) {
      const e = body.children[eq + 1];
      if (e) exprs.push(e);
    } else {
      collectReturns(body, exprs, "jump_expression", KOTLIN_RETURN_BARRIERS);
    }
  }
  if (exprs.length === 0) return null;
  let found: string | null = null;
  for (const e of exprs) {
    const t = returnedClass(e, params);
    if (!t || (found && found !== t)) return null;
    found = t;
  }
  return found;
}

const JAVA_RETURN_BARRIERS: ReadonlySet<string> = new Set(["lambda_expression", "class_body", "method_declaration"]);
const KOTLIN_RETURN_BARRIERS: ReadonlySet<string> = new Set(["lambda_literal", "anonymous_function", "function_declaration", "class_body"]);

function collectReturns(n: Node, out: Node[], returnType: string, barriers: ReadonlySet<string>): void {
  for (const c of n.children) {
    if (barriers.has(c.type)) continue;
    if (c.type === returnType) {
      if (returnType === "jump_expression" && c.children[0]?.type !== "return") continue;
      const value = c.namedChildren[0];
      if (value) out.push(value);
      continue;
    }
    collectReturns(c, out, returnType, barriers);
  }
}

/** The class an expression hands back: a plain construction, or a parameter's declared type. */
function returnedClass(e: Node, params: Array<{ name: string; type: string }>): string | null {
  if (e.type === "identifier" || e.type === "simple_identifier") {
    const p = params.find((x) => x.name === e.text);
    return p ? simpleName(p.type) : null;
  }
  const fact = expressionFact(e);
  return fact?.constructed && !fact.anonymous && fact.type ? fact.type : null;
}

// ─── Statement scans: Guice `bind(..)` chains, Koin `module { … }` ────────

/** Walk a member's subtree for Guice bind chains and Koin modules. */
function scanBody(member: Node, ctx: Ctx): void {
  const visit = (n: Node): void => {
    if (ctx.lang === "java") {
      // A bind chain is a statement; anything else may hold one deeper (an
      // anonymous `new AbstractModule() { configure() { bind(..) } }`).
      if (n.type === "expression_statement") {
        const e = n.namedChildren[0];
        if (e?.type === "method_invocation" && ctx.guice && guiceChain(e, ctx)) return;
      }
    } else if (n.type === "call_expression") {
      if (ctx.koin && isKoinModule(n)) {
        koinModule(n, ctx);
        return;
      }
      if (ctx.guice && guiceChain(n, ctx)) return;
    }
    for (const c of n.children) visit(c);
  };
  for (const c of member.children) visit(c);
}

interface ChainCall {
  name: string;
  args: Node[];
  typeArgs: string[];
  /** The receiver of the first call in the chain (null when unqualified). */
  receiver: Node | null;
}

/** `a(..).b(..).c(..)` → [a, b, c], with the root receiver. Java `method_invocation` / Kotlin `call_expression`. */
function unwindChain(expr: Node): ChainCall[] {
  const calls: ChainCall[] = [];
  let n: Node | null | undefined = expr;
  while (n) {
    if (n.type === "method_invocation") {
      const obj = n.childForFieldName("object");
      calls.unshift({ name: n.childForFieldName("name")?.text ?? "", args: callArguments(n), typeArgs: [], receiver: obj });
      n = obj?.type === "method_invocation" ? obj : null;
    } else if (n.type === "call_expression") {
      const callee: Node | undefined = n.children[0];
      const suffix = n.children.find((c) => c.type === "call_suffix");
      const typeArgs = (suffix?.children.find((c) => c.type === "type_arguments")?.namedChildren ?? [])
        .map((p) => simpleName(p.text))
        .filter((s): s is string => !!s);
      const name = calleeOrMethodName(n) ?? "";
      const head: Node | null = callee?.type === "navigation_expression" ? callee.children[0] ?? null : null;
      calls.unshift({ name, args: callArguments(n), typeArgs, receiver: head });
      n = head?.type === "call_expression" ? head : null;
    } else {
      break;
    }
  }
  return calls;
}

/**
 * A Guice binding statement: `bind(I.class)[.annotatedWith(..)].to(Impl.class)
 * [.in(..)]` (or `.toInstance(new Impl())`), on no receiver, `binder()` or
 * `binder`; kotlin-guice `bind<I>().to<Impl>()`. Returns true when the
 * expression was a bind chain (reported or not).
 */
function guiceChain(expr: Node, ctx: Ctx): boolean {
  let calls = unwindChain(expr);
  if (calls[0]?.name === "binder" && calls[0].args.length === 0 && !calls[0].receiver) calls = calls.slice(1);
  const root = calls[0];
  if (!root || root.name !== "bind") return false;
  const recv = root.receiver;
  if (recv && !(recv.type === "method_invocation" || recv.type === "call_expression" || recv.text === "binder" || recv.text === "this")) return false;
  if (recv && (recv.type === "method_invocation" || recv.type === "call_expression") && calleeOrMethodName(recv) !== "binder") return false;
  if (calls.length < 2) return true;

  let service: string | null = root.typeArgs[0] ?? null;
  let qualifier: string | undefined;
  const arg = root.args[0];
  if (!service && arg) {
    service = classRefName(arg);
    if (!service) {
      const key = guiceKey(arg);
      if (key) { service = key.type; qualifier = key.qualifier; }
    }
  }
  if (!service) return true;
  let implementation: string | null = null;
  for (const c of calls.slice(1)) {
    if (c.name === "annotatedWith") {
      const q = c.args[0] ? guiceQualifier(c.args[0]) : null;
      if (!q) return true;
      qualifier = q;
    } else if (c.name === "to") {
      const a = c.args[0];
      implementation = c.typeArgs[0] ?? (a ? classRefName(a) ?? guiceKey(a)?.type ?? null : null);
    } else if (c.name === "toInstance") {
      const fact = c.args[0] ? expressionFact(c.args[0]) : null;
      implementation = fact?.constructed && !fact.anonymous && fact.type ? fact.type : null;
    } else if (c.name === "toProvider" || c.name === "toConstructor") {
      return true;
    }
  }
  if (!implementation || (implementation === service && !qualifier)) return true;
  const b: DiBinding = { service, implementation, line: expr.startPosition.row + 1, via: "bind" };
  if (qualifier) { b.qualifier = qualifier; b.keyedOnly = true; }
  ctx.out.push(b);
  return true;
}

/** `module { … }` / `module(createdAtStart = true) { … }` (Koin). */
function isKoinModule(n: Node): boolean {
  const callee = n.children[0];
  if (callee?.type !== "simple_identifier" || callee.text !== "module") return false;
  return n.children.some((c) => c.type === "call_suffix" && c.children.some((s) => s.type === "annotated_lambda"));
}

function lambdaOf(n: Node): Node | null {
  const suffix = n.children.find((c) => c.type === "call_suffix");
  return suffix?.children.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal") ?? null;
}

function statementsOf(lambda: Node | null | undefined): Node[] {
  return lambda?.children.find((c) => c.type === "statements")?.namedChildren ?? [];
}

function koinModule(n: Node, ctx: Ctx): void {
  for (const stmt of statementsOf(lambdaOf(n))) koinStatement(stmt, ctx);
}

/** A call with its trailing-lambda / argument parts gathered (`single<I>(named("x")) { … }` nests two calls). */
function flattenCall(n: Node): { name: string | null; typeArgs: string[]; args: Node[]; lambda: Node | null } {
  const typeArgs: string[] = [];
  const args: Node[] = [];
  let lambda: Node | null = null;
  let cur: Node = n;
  for (;;) {
    const suffix = cur.children.find((c) => c.type === "call_suffix");
    if (suffix) {
      const ta = suffix.children.find((c) => c.type === "type_arguments");
      if (ta && typeArgs.length === 0) {
        for (const p of ta.namedChildren) {
          const s = simpleName(p.text);
          if (s) typeArgs.push(s);
        }
      }
      args.unshift(...callArguments(cur));
      lambda ??= suffix.children.find((c) => c.type === "annotated_lambda")?.namedChildren.find((c) => c.type === "lambda_literal") ?? null;
    }
    const callee = cur.children[0];
    if (callee?.type === "call_expression") { cur = callee; continue; }
    return { name: callee?.type === "simple_identifier" ? callee.text : null, typeArgs, args, lambda };
  }
}

/** One statement of a Koin module (or scope) body. */
function koinStatement(stmt: Node, ctx: Ctx): void {
  // Peel infix options: `def bind I::class`, `def binds arrayOf(I::class, J::class)`, `def withOptions { … }`.
  const extra: string[] = [];
  let key: string | undefined;
  let def = stmt;
  while (def.type === "infix_expression") {
    const kids = def.namedChildren;
    const op = kids[1]?.text;
    const right = kids[2];
    if (!right) return;
    if (op === "bind") {
      const c = classRefName(right);
      if (c) extra.push(c);
    } else if (op === "binds") {
      extra.push(...expressionValues(right).filter((v) => /^[A-Z]\w*$/.test(v)));
    } else if (op === "withOptions") {
      const opts = koinOptions(right.type === "lambda_literal" ? right : null);
      extra.push(...opts.services);
      key ??= opts.key;
    } else {
      return;
    }
    def = kids[0]!;
  }
  if (def.type !== "call_expression") return;
  const call = flattenCall(def);
  if (!call.name) return;

  if (KOIN_DEFINITIONS.has(call.name) || KOIN_CONSTRUCTOR_DSL.has(call.name)) {
    for (const a of call.args) key ??= koinQualifier(a) ?? undefined;
    const declared = call.typeArgs[0];
    let implementation: string | null;
    let competing = false;
    const services = declared ? [declared] : [];
    if (KOIN_CONSTRUCTOR_DSL.has(call.name)) {
      // `singleOf(::Impl) { bind<I>(); named("x") }`
      implementation = call.args[0] ? constructorRefName(call.args[0]) : null;
      const opts = koinOptions(call.lambda);
      services.push(...opts.services);
      key ??= opts.key;
    } else {
      // `single<I> { Impl(get()) }` — the class the definition's lambda returns:
      // a construction, or `get<Impl>()` forwarding to another definition.
      const fact: ExprFact | null = lastExpressionFact(call.lambda);
      implementation = fact?.type && !fact.anonymous && (fact.constructed || !fact.qualifier) ? fact.type : null;
      // A typed definition whose body says neither still answers for its type
      // — reported as itself, so it competes with the other definitions.
      if (!implementation && declared) {
        implementation = declared;
        competing = true;
      }
    }
    services.push(...extra);
    if (!implementation) return;
    const line = stmt.startPosition.row + 1;
    for (const service of new Set(services)) {
      if (service === implementation && !competing) continue;
      const b: DiBinding = { service, implementation, line, via: call.name };
      if (key) { b.qualifier = key; b.keyedOnly = true; }
      ctx.out.push(b);
    }
    return;
  }
  // `scope<MainActivity> { scoped<I> { … } }`, `scope(named("x")) { … }`, `activityScope { … }`.
  if (/^(?:scope|\w+Scope)$/.test(call.name) && call.lambda) {
    for (const s of statementsOf(call.lambda)) koinStatement(s, ctx);
  }
}

/** `{ bind<I>(); binds(listOf(J::class)); named("x") }` — a Koin definition's options. */
function koinOptions(lambda: Node | null): { services: string[]; key?: string } {
  const services: string[] = [];
  let key: string | undefined;
  for (const s of statementsOf(lambda)) {
    if (s.type !== "call_expression") continue;
    const c = flattenCall(s);
    if (c.name === "bind") {
      if (c.typeArgs[0]) services.push(c.typeArgs[0]);
      else if (c.args[0]) {
        const r = classRefName(c.args[0]);
        if (r) services.push(r);
      }
    } else if (c.name === "binds") {
      for (const a of c.args) services.push(...expressionValues(a).filter((v) => /^[A-Z]\w*$/.test(v)));
    } else if (c.name === "named") {
      key ??= koinQualifier(s) ?? undefined;
    }
  }
  return { services, key };
}

/** `::Impl` → `Impl` (a constructor reference). */
function constructorRefName(n: Node): string | null {
  if (n.type !== "callable_reference") return null;
  const text = n.text.replace(/\s+/g, "");
  const m = /^(?:[\w.]*)::([A-Z]\w*)$/.exec(text);
  return m && !text.endsWith("::class") ? m[1]! : null;
}
