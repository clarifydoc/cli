import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding } from "../../../types/analysis.js";
import { constructedClass, tokenRef, tokenTextOf, type TokenRef } from "./di.js";
import { stripQuotes } from "../../shared/node-helpers.js";

/**
 * Dependency-injection registrations a TS/JS file makes (`meta.ast.diBindings`):
 *
 * - NestJS / Angular provider objects `{ provide: X, useClass | useExisting |
 *   useFactory | useValue }` — wherever they are written (`@Module` /
 *   `@NgModule` / `@Component` providers, `ApplicationConfig`,
 *   `bootstrapApplication`, `makeEnvironmentProviders`, route providers, a
 *   dynamic module's `forRoot()`, a `const` provider spread into a list): the
 *   object literal itself is the registration, so it is read where it stands.
 *   `multi: true` contributes to an array and is skipped. Angular
 *   `@Injectable({ providedIn: 'root', useClass: X })` is a default
 *   (`ifAbsent`) for the decorated token class.
 * - InversifyJS `bind<I>(id).to(Impl)` chains (`container.bind`, `rebind`, the
 *   `bind` a `ContainerModule` callback receives), with `toSelf`, `toService`,
 *   `toConstantValue(new X())`, `toDynamicValue(() => new X())`,
 *   `whenTargetNamed`/`whenTargetTagged` (keyed) and `whenInjectedInto(C)`
 *   (contextual); `@provide(id)` class decorators (inversify-binding-decorators;
 *   its chained `@fluentProvide(id)….done()` does not parse as a decorator in
 *   the grammar and is not read).
 * - tsyringe `register(token, { useClass | useToken | useFactory | useValue })`,
 *   `registerSingleton` / `registerType` (token, Class), `registerInstance(token,
 *   new X())`, `@registry([{ token, useClass }])`, `@injectable({ token })`.
 *
 * A factory names an implementation only when it returns one plain
 * construction (`() => new X()`, `{ …; return new X(); }`); one that chooses at
 * runtime (`mode === 'a' ? new A() : new B()`) is not a static registration and
 * yields nothing. Tokens keep their source text (`USER_REPO`, `TYPES.UserRepo`,
 * strings unquoted) so they meet the injection point's `qualifier`.
 */
export function extractJsDiBindings(tree: Tree, sourceText: string, _filePath: string): DiBinding[] {
  // One pass over the text rules out the (vast) majority of files.
  if (!ANY_REGISTRATION_GATE.test(sourceText)) return [];
  const gates: Gates = {
    providers: PROVIDER_GATE.test(sourceText),
    inversify: sourceText.includes("bind") && INVERSIFY_GATE.test(sourceText),
    tsyringe: TSYRINGE_GATE.test(sourceText),
    decorators: CLASS_DECORATOR_GATE.test(sourceText),
  };

  const out: DiBinding[] = [];
  const walk = (node: Node): void => {
    const type = node.type;
    if (type === "object" && gates.providers) {
      const b = providerObject(node, "provide");
      if (b) out.push(b);
    } else if (type === "call_expression") {
      if (gates.inversify) inversifyChain(node, out);
      if (gates.tsyringe) tsyringeRegister(node, out);
    } else if (type === "decorator" && gates.decorators) {
      classDecorator(node, out);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.rootNode);
  return out;
}

interface Gates {
  providers: boolean;
  inversify: boolean;
  tsyringe: boolean;
  decorators: boolean;
}

/** Any of the family gates below, as one regex (a single scan of the text). */
const ANY_REGISTRATION_GATE =
  /\buse(?:Class|Existing|Factory|Value)\b|\.to(?:Self|Service|ConstantValue|DynamicValue)?\s*\(|\bregister(?:Singleton|Type|Instance)?\s*[<(]|@(?:provide|registry)\s*\(|@[Ii]njectable\s*\(\s*\{/;
/** A provider object has a `use*` key (`{ provide: X, useClass: Y }`). */
const PROVIDER_GATE = /\buse(?:Class|Existing|Factory|Value)\b/;
/** An Inversify chain ends in a `.to…(` link. */
const INVERSIFY_GATE = /\.to(?:Self|Service|ConstantValue|DynamicValue)?\s*\(/;
/** tsyringe registration calls (`register`, `registerSingleton`, …). */
const TSYRINGE_GATE = /\bregister(?:Singleton|Type|Instance)?\s*[<(]/;
/** Class decorators that register: `@provide(`, `@registry(`, `@injectable({`, `@Injectable({`. */
const CLASS_DECORATOR_GATE = /@(?:provide|registry)\s*\(|@[Ii]njectable\s*\(\s*\{/;

/** `{ key: value }` pairs of an object literal, by key name (identifier or string keys). */
function objectPairs(obj: Node): Map<string, Node> {
  const pairs = new Map<string, Node>();
  for (const member of obj.namedChildren) {
    if (member.type !== "pair") continue;
    const key = member.childForFieldName("key");
    const value = member.childForFieldName("value");
    if (!key || !value) continue;
    const name = key.type === "string" ? stripQuotes(key.text) : key.text;
    if (!pairs.has(name)) pairs.set(name, value);
  }
  return pairs;
}

/** A registration, unless it binds a service to itself without a name (that adds nothing). */
function binding(
  service: string,
  implementation: string | null,
  line: number,
  via: string,
  extra: Partial<DiBinding> = {},
): DiBinding | null {
  if (!service || !implementation) return null;
  if (service === implementation && !extra.qualifier) return null;
  return { service, implementation, line, via, ...extra };
}

/** The implementation a class-or-token reference names: a class by its bare name, a token (alias) as written. */
function implementationOf(ref: TokenRef | null): string | null {
  if (!ref) return null;
  return ref.kind === "class" ? ref.name : ref.text;
}

/** `useClass: X` / `.to(X)` / `registerSingleton(t, X)`: a class reference → its bare simple name. */
function classReference(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "member_expression") {
    const prop = node.childForFieldName("property");
    return prop ? prop.text : null;
  }
  const ref = tokenRef(node);
  return ref?.kind === "class" ? ref.name : null;
}

/**
 * The class a factory function returns: `() => new X(…)`, `async () => new X()`,
 * `function () { …; return new X(); }` — exactly one `return` in the body and
 * it constructs. tsyringe's caching wrappers (`instanceCachingFactory(c =>
 * new X())`) are looked through. Anything else → null.
 */
export function factoryProduct(fn: Node | null): string | null {
  if (!fn) return null;
  if (fn.type === "call_expression") {
    const callee = fn.childForFieldName("function")?.text;
    if (callee !== "instanceCachingFactory" && callee !== "instancePerContainerCachingFactory") return null;
    return factoryProduct(fn.childForFieldName("arguments")?.namedChild(0) ?? null);
  }
  if (fn.type !== "arrow_function" && fn.type !== "function_expression" && fn.type !== "function") return null;
  const body = fn.childForFieldName("body");
  if (!body) return null;
  if (body.type !== "statement_block") return constructedClass(body);
  const returns: Node[] = [];
  collectReturns(body, returns);
  return returns.length === 1 ? constructedClass(returns[0]!.namedChild(0)) : null;
}

/** Every `return` of a function body, not descending into nested functions/classes. */
function collectReturns(node: Node, out: Node[]): void {
  for (const child of node.namedChildren) {
    const t = child.type;
    if (t === "return_statement") out.push(child);
    else if (t === "arrow_function" || t === "function_expression" || t === "function_declaration" || t === "class_declaration" || t === "class") continue;
    else collectReturns(child, out);
    if (out.length > 1) return;
  }
}

/**
 * `{ provide: X, useClass: Y }` (keyKey "provide") or tsyringe's registry entry
 * `{ token: X, useClass: Y }` (keyKey "token") → one binding.
 */
function providerObject(obj: Node, keyKey: "provide" | "token", extra: Partial<DiBinding> = {}): DiBinding | null {
  // Cheap shape test first: a provider object has its key among the first pairs.
  const first = obj.namedChild(0);
  if (!first || first.type !== "pair") return null;
  const pairs = objectPairs(obj);
  const provide = pairs.get(keyKey);
  if (!provide) return null;
  if (pairs.get("multi")?.type === "true") return null;
  const service = tokenRef(provide);
  if (!service) return null;
  return useProvider(tokenTextOf(service), pairs, obj.startPosition.row + 1, extra);
}

/** The `use*` half of a provider: what is built for `service`. */
function useProvider(service: string, pairs: Map<string, Node>, line: number, extra: Partial<DiBinding>): DiBinding | null {
  const useClass = pairs.get("useClass");
  if (useClass) return binding(service, classReference(useClass), line, "useClass", extra);
  const useExisting = pairs.get("useExisting") ?? pairs.get("useToken");
  if (useExisting) {
    return binding(service, implementationOf(tokenRef(useExisting)), line, pairs.has("useExisting") ? "useExisting" : "useToken", extra);
  }
  const useFactory = pairs.get("useFactory");
  if (useFactory) return binding(service, factoryProduct(useFactory), line, "useFactory", extra);
  const useValue = pairs.get("useValue");
  if (useValue) return binding(service, constructedClass(useValue), line, "useValue", extra);
  return null;
}

// ── InversifyJS ──────────────────────────────────────────────────────────────

/** Links that can follow `bind(id)` in a chain. */
const INVERSIFY_LINKS: ReadonlySet<string> = new Set([
  "to", "toSelf", "toService", "toConstantValue", "toDynamicValue",
  "inSingletonScope", "inTransientScope", "inRequestScope",
  "whenTargetNamed", "whenNamed", "whenTargetTagged", "whenTagged", "whenInjectedInto",
  "onActivation", "onDeactivation",
]);

/** A call chain → its links innermost first (`a.bind(x).to(Y)` → bind, to), or null if not a plain chain. */
function chainLinks(top: Node): Array<{ name: string; call: Node }> | null {
  const links: Array<{ name: string; call: Node }> = [];
  let cur: Node | null = top;
  for (let guard = 0; cur && guard < 12; guard++) {
    if (cur.type !== "call_expression") break;
    const fn: Node | null = cur.childForFieldName("function");
    if (fn?.type === "member_expression") {
      links.push({ name: fn.childForFieldName("property")?.text ?? "", call: cur });
      cur = fn.childForFieldName("object");
    } else if (fn?.type === "identifier") {
      links.push({ name: fn.text, call: cur });
      cur = null;
    } else {
      return null;
    }
  }
  return links.reverse();
}

function argsOf(call: Node): Node[] {
  return call.childForFieldName("arguments")?.namedChildren ?? [];
}

/**
 * An Inversify registration chain, read at its top call (a link whose result
 * is not itself the receiver of another link): `container.bind<I>(id).to(X)
 * .inSingletonScope().whenTargetNamed('n')`. The service is the token as
 * written. A NAMED/TAGGED registration with a type argument is also recorded
 * under that type, keyed by the name: `@inject(TYPES.Logger) @named('file')
 * logger: ILogger` is an `ILogger` point qualified `file`, and that is the
 * pair the linker can match it on (a point has one qualifier, and the token
 * alone does not pick among the named registrations).
 */
function inversifyChain(top: Node, out: DiBinding[]): void {
  if (top.parent?.type === "member_expression") return; // an inner link
  const fn = top.childForFieldName("function");
  if (fn?.type !== "member_expression") return;
  if (!INVERSIFY_LINKS.has(fn.childForFieldName("property")?.text ?? "")) return;
  const links = chainLinks(top);
  if (!links || links.length < 2) return;
  const head = links[0]!;
  if (head.name !== "bind" && head.name !== "rebind") return;
  const headArgs = argsOf(head.call);
  if (headArgs.length !== 1) return;
  const serviceRef = tokenRef(headArgs[0]!);
  if (!serviceRef) return;
  const service = tokenTextOf(serviceRef);
  const typeArg = head.call.childForFieldName("type_arguments")?.namedChild(0);
  const serviceType = typeArg && typeArg.type === "type_identifier" ? typeArg.text : null;

  let implementation: string | null = null;
  let via = "";
  const extra: Partial<DiBinding> = {};
  for (const link of links.slice(1)) {
    const args = argsOf(link.call);
    switch (link.name) {
      case "to":
        implementation = classReference(args[0] ?? null);
        via = `${head.name}.to`;
        break;
      case "toSelf":
        implementation = serviceRef.kind === "class" ? serviceRef.name : null;
        via = `${head.name}.toSelf`;
        break;
      case "toService":
        implementation = implementationOf(tokenRef(args[0] ?? null));
        via = `${head.name}.toService`;
        break;
      case "toConstantValue":
        implementation = constructedClass(args[0] ?? null);
        via = `${head.name}.toConstantValue`;
        break;
      case "toDynamicValue":
        implementation = factoryProduct(args[0] ?? null);
        via = `${head.name}.toDynamicValue`;
        break;
      case "whenTargetNamed":
      case "whenNamed": {
        const name = args[0]?.type === "string" ? stripQuotes(args[0].text) : null;
        if (name) {
          extra.qualifier = name;
          extra.keyedOnly = true;
        }
        break;
      }
      case "whenTargetTagged":
      case "whenTagged": {
        const key = args[0]?.type === "string" ? stripQuotes(args[0].text) : null;
        const value = args[1] ? (args[1].type === "string" ? stripQuotes(args[1].text) : args[1].text) : null;
        if (key !== null && value !== null) {
          extra.qualifier = `${key}=${value}`;
          extra.keyedOnly = true;
        }
        break;
      }
      case "whenInjectedInto": {
        const consumer = classReference(args[0] ?? null);
        if (consumer) extra.consumer = consumer;
        break;
      }
      default:
        break;
    }
  }
  const line = top.startPosition.row + 1;
  const b = binding(service, implementation, line, via, extra);
  if (!b) return;
  out.push(b);
  if (extra.qualifier && serviceType && serviceType !== service) {
    out.push({ ...b, service: serviceType });
  }
}

// ── tsyringe ─────────────────────────────────────────────────────────────────

/** `container.register(...)`-family calls (member or free function, e.g. VS Code's `registerSingleton`). */
function tsyringeRegister(call: Node, out: DiBinding[]): void {
  const fn = call.childForFieldName("function");
  let method: string;
  if (fn?.type === "member_expression") method = fn.childForFieldName("property")?.text ?? "";
  else if (fn?.type === "identifier") method = fn.text;
  else return;
  if (method !== "register" && method !== "registerSingleton" && method !== "registerType" && method !== "registerInstance") {
    return;
  }
  // A bare `register(…)` is any project's function; only the specific names stand alone.
  if (method === "register" && fn.type !== "member_expression") return;
  const args = argsOf(call);
  if (args.length < 2) return;
  const tokenNode = tokenRef(args[0]!);
  if (!tokenNode) return;
  const service = tokenTextOf(tokenNode);
  const line = call.startPosition.row + 1;
  const provider = args[1]!;
  let b: DiBinding | null = null;
  if (method === "register") {
    // `register(token, { useClass | useToken | useFactory | useValue })` —
    // the provider object is what makes a `register` call a DI registration.
    if (provider.type !== "object") return;
    b = useProvider(service, objectPairs(provider), line, {});
    if (b) b.via = `register/${b.via}`;
  } else if (method === "registerInstance") {
    b = binding(service, constructedClass(provider), line, method);
  } else {
    b = binding(service, classReference(provider), line, method);
  }
  if (b) out.push(b);
}

// ── Class decorators ─────────────────────────────────────────────────────────

/** The class a decorator is attached to (directly, or through `export` / `export default`). */
function decoratedClassName(decorator: Node): string | null {
  let target = decorator.parent;
  if (target?.type === "export_statement") target = target.childForFieldName("declaration");
  if (target?.type !== "class_declaration" && target?.type !== "abstract_class_declaration") return null;
  return target.childForFieldName("name")?.text ?? null;
}

/**
 * Registrations a class decorator makes for the class it decorates:
 * Angular `@Injectable({ providedIn, useClass | useExisting | useFactory | useValue })`
 * (a default — `ifAbsent` — for the decorated token class), inversify-binding-
 * decorators `@provide(id)`, tsyringe
 * `@registry([{ token, useClass }])` and `@injectable({ token })`.
 */
function classDecorator(decorator: Node, out: DiBinding[]): void {
  const expr = decorator.namedChild(0);
  if (expr?.type !== "call_expression") return;
  const fn = expr.childForFieldName("function");
  if (fn?.type !== "identifier") return;
  const name = fn.text;
  const args = argsOf(expr);
  const line = decorator.startPosition.row + 1;

  if (name === "registry") {
    if (args[0]?.type !== "array") return;
    for (const entry of args[0].namedChildren) {
      if (entry.type !== "object") continue;
      const b = providerObject(entry, "token");
      if (b) {
        b.via = "@registry";
        out.push(b);
      }
    }
    return;
  }

  const className = decoratedClassName(decorator);
  if (!className) return;

  if (name === "Injectable" || name === "injectable") {
    if (args[0]?.type !== "object") return;
    const pairs = objectPairs(args[0]);
    if (name === "Injectable") {
      // Angular: the decorated class is a token whose default provider is this.
      const b = useProvider(className, pairs, line, { ifAbsent: true });
      if (b) {
        b.via = `@Injectable/${b.via}`;
        out.push(b);
      }
      return;
    }
    // tsyringe `@injectable({ token: 'IFoo' })` / `{ token: ['IA', 'IB'] }`.
    const token = pairs.get("token");
    const tokens = token?.type === "array" ? token.namedChildren : token ? [token] : [];
    for (const t of tokens) {
      const ref = tokenRef(t);
      const b = ref ? binding(tokenTextOf(ref), className, line, "@injectable") : null;
      if (b) out.push(b);
    }
    return;
  }

  if (name === "provide") {
    const ref = tokenRef(args[0] ?? null);
    const b = ref ? binding(tokenTextOf(ref), className, line, "@provide") : null;
    if (b) out.push(b);
  }
}
