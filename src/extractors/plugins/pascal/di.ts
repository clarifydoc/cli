import type { Node, Tree } from "web-tree-sitter";
import type { DiBinding, FunctionInfo } from "../../../types/analysis.js";
import { isBuiltinType } from "../../shared/builtin-types.js";

/**
 * Dependency-injection facts for Delphi, Spring4D style: container
 * registrations (`GlobalContainer.RegisterType<TSqlRepo>.Implements<IRepo>`),
 * container lookups (`GlobalContainer.Resolve<IRepo>`,
 * `ServiceLocator.GetService<IClock>`), and the locals a routine declares or
 * fills from either. The symbol linker joins them; nothing here decides which
 * implementation an injection point receives.
 *
 * tree-sitter-pascal shapes (all generic instantiations are `exprTpl`):
 *   `X.RegisterType<TFoo>.Implements<IFoo>`
 *       exprTpl{entity: exprDot{lhs: exprTpl{entity: exprDot "X.RegisterType", args TFoo}, rhs Implements}, args IFoo}
 *   `….Implements<IFoo>('name')`   exprCall{entity: exprTpl…, args: exprArgs{literalString}}
 *   `X.Resolve<IFoo>('name').Send` exprDot{lhs: exprCall{entity: exprTpl…}, rhs Send}
 */

/** Spring4D lookups whose result is the requested type. */
const LOCATOR_METHODS = new Set(["resolve", "getservice"]);

/** `'sms'` → `sms` (Pascal doubles a quote inside a string). */
function unquote(text: string): string | null {
  const t = text.trim();
  return t.length >= 2 && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : null;
}

/** A type as the container names it: `Shop.Intf.IRepo` → `IRepo`, `IRepo<TUser>` → `IRepo`. */
export function barePascalTypeName(text: string): string | null {
  const simple = text.replace(/<[\s\S]*$/, "").trim().split(".").pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(simple) ? simple : null;
}

/**
 * The named children of `node` under field `field` (`args` of an `exprTpl`).
 * The grammar files the separating `,` under the same field, so anonymous
 * tokens are dropped.
 */
function fieldChildren(node: Node, field: string): Node[] {
  const out: Node[] = [];
  const kids = node.children;
  for (let i = 0; i < kids.length; i++) {
    if (node.fieldNameForChild(i) === field && kids[i]!.isNamed) out.push(kids[i]!);
  }
  return out;
}

/** The arguments of an `exprCall`, one node per argument. */
function callArgs(call: Node): Node[] {
  const args = call.childForFieldName("args");
  return args ? args.namedChildren.filter((n) => n.type !== "comment") : [];
}

/**
 * The type (and name) a container lookup returns: `X.Resolve<IRepo>` →
 * IRepo, `X.Resolve<INotifier>('sms')` → INotifier + `sms`,
 * `ServiceLocator.GetService<IClock>` → IClock. Null for anything else,
 * including a lookup whose argument is not a literal name.
 */
export function locatorLookup(node: Node): { type: string; qualifier?: string } | null {
  let tpl = node;
  let qualifier: string | undefined;
  if (node.type === "exprCall") {
    const entity = node.child(0);
    if (!entity || entity.type !== "exprTpl") return null;
    const args = callArgs(node);
    if (args.length > 1) return null;
    if (args.length === 1) {
      if (args[0]!.type !== "literalString") return null;
      const name = unquote(args[0]!.text);
      if (name === null) return null;
      qualifier = name;
    }
    tpl = entity;
  } else if (node.type !== "exprTpl") {
    return null;
  }
  const entity = tpl.child(0);
  if (!entity) return null;
  const method = entity.type === "exprDot" ? entity.childForFieldName("rhs") : entity.type === "identifier" ? entity : null;
  if (!method || method.type !== "identifier" || !LOCATOR_METHODS.has(method.text.toLowerCase())) return null;
  const typeArgs = fieldChildren(tpl, "args");
  if (typeArgs.length !== 1) return null;
  const type = typeArgs[0]!.text.trim();
  return qualifier !== undefined ? { type, qualifier } : { type };
}

/**
 * The class an expression constructs: `TFoo.Create`, `TFoo.Create(x)`,
 * `TList<TUser>.Create` — as written. Delphi constructors may be named
 * anything, but only `Create` is read as one: `TFoo.Instance` or
 * `TFoo.FromFile(…)` may return another type.
 */
export function constructedClass(node: Node): string | null {
  let dot = node;
  if (node.type === "exprCall") {
    const entity = node.child(0);
    if (!entity) return null;
    dot = entity;
  }
  if (dot.type !== "exprDot") return null;
  const lhs = dot.childForFieldName("lhs");
  const rhs = dot.childForFieldName("rhs");
  if (!lhs || !rhs || rhs.type !== "identifier" || rhs.text.toLowerCase() !== "create") return null;
  if (lhs.type !== "identifier" && lhs.type !== "exprTpl") return null;
  return lhs.text;
}

/**
 * The type of the receiver a call is made on, when the expression states it:
 * a container lookup chained straight into the call
 * (`GlobalContainer.Resolve<INotifier>('sms').Send('x')`,
 * `ServiceLocator.GetService<IClock>.NowUtc`). Called for every call node, so
 * it bails on the first node type that cannot be one.
 */
export function pascalReceiverTypeOf(node: Node): { type: string; qualifier?: string } | null {
  let callee: Node | null;
  if (node.type === "exprCall") callee = node.child(0);
  else if (node.type === "statement") callee = node.child(0);
  else return null;
  if (!callee || callee.type !== "exprDot") return null;
  const lhs = callee.child(0);
  if (!lhs || (lhs.type !== "exprTpl" && lhs.type !== "exprCall")) return null;
  return locatorLookup(lhs);
}

// ─── Locals ──────────────────────────────────────────────────────────────────

type LocalType = NonNullable<FunctionInfo["localTypes"]>[number];

/**
 * Locals whose type a routine states → `FunctionInfo.localTypes`:
 *
 *   var Repo: IOrderRepo;                  → Repo: IOrderRepo (the declared type)
 *   R := GlobalContainer.Resolve<INotifier>('sms');   (R declared INotifier)
 *                                          → R: INotifier, qualifier sms
 *   var C := TDiscountCalc.Create;         → C: TDiscountCalc (Delphi 10.3 inline var)
 *   var N := GlobalContainer.Resolve<INotifier>;      → N: INotifier
 *
 * The grammar predates inline variables: `var X := …` parses as an
 * assignment to an identifier `var` with the name in an ERROR node, which is
 * read here; the typed form `var X: T := …` breaks the parse and is skipped.
 * Builtin-typed locals carry nothing for a receiver and are left out. A
 * name given two different types (or two different lookup names) states
 * nothing and is dropped.
 */
export function pascalLocalTypes(defProc: Node, readAssignments = true): LocalType[] {
  const declared = new Map<string, LocalType>(); // lower-cased name → local
  for (const section of defProc.children) {
    if (section.type !== "declVars") continue;
    for (const v of section.children) {
      if (v.type !== "declVar") continue;
      const type = v.childForFieldName("type");
      const named = type?.child(0);
      if (!type || !named || named.type !== "typeref") continue;
      const typeText = type.text.trim();
      const simple = barePascalTypeName(typeText);
      if (!simple || isBuiltinType(simple, "pascal")) continue;
      for (const name of fieldChildren(v, "name")) {
        if (name.type === "identifier") declared.set(name.text.toLowerCase(), { name: name.text, type: typeText });
      }
    }
  }

  const body = readAssignments ? defProc.childForFieldName("body") : null;
  const qualifiers = new Map<string, string | null>();
  const inline = new Map<string, LocalType | null>();
  if (body) {
    for (const assignment of body.descendantsOfType("assignment")) {
      // Only a lookup or a construction states a type (node.type is free; text is not).
      const rhs = assignment.childForFieldName("rhs");
      if (!rhs || (rhs.type !== "exprTpl" && rhs.type !== "exprCall" && rhs.type !== "exprDot")) continue;
      const lhs = assignment.childForFieldName("lhs");
      if (!lhs || lhs.type !== "identifier") continue;
      if (lhs.text.toLowerCase() === "var") {
        // `var X := …` — the name sits in the ERROR node after `var`.
        const err = lhs.nextSibling;
        const ids = err?.type === "ERROR" ? err.namedChildren : [];
        if (ids.length !== 1 || ids[0]!.type !== "identifier") continue;
        const name = ids[0]!.text;
        const value = locatorLookup(rhs) ?? (constructedClass(rhs) ? { type: constructedClass(rhs)! } : null);
        const key = name.toLowerCase();
        if (!value || declared.has(key)) continue;
        const local: LocalType = value.qualifier ? { name, type: value.type, qualifier: value.qualifier } : { name, type: value.type };
        const prev = inline.get(key);
        inline.set(key, prev === undefined ? local : prev && prev.type === local.type && prev.qualifier === local.qualifier ? prev : null);
        continue;
      }
      // A declared local filled by a named lookup carries the name.
      const key = lhs.text.toLowerCase();
      const local = declared.get(key);
      if (!local) continue;
      const lookup = locatorLookup(rhs);
      if (!lookup) continue;
      const named = lookup.qualifier !== undefined && barePascalTypeName(lookup.type)?.toLowerCase() === barePascalTypeName(local.type)?.toLowerCase()
        ? lookup.qualifier
        : null;
      const prev = qualifiers.get(key);
      qualifiers.set(key, prev === undefined || prev === named ? named : null);
    }
  }

  const out: LocalType[] = [];
  for (const [key, local] of declared) {
    const qualifier = qualifiers.get(key);
    out.push(qualifier ? { ...local, qualifier } : local);
  }
  for (const local of inline.values()) {
    if (local && !isBuiltinType(barePascalTypeName(local.type) ?? "", "pascal")) out.push(local);
  }
  return out;
}

// ─── Registrations ───────────────────────────────────────────────────────────

/** One `.Name<T…>(args)` link of a flattened fluent chain. */
interface Segment {
  name: string;
  typeArgs: Node[];
  args: Node[];
}

/** `A.B<T>.C<U>('x').D` → its links in order, or null for anything that is not such a chain. */
function flattenChain(expr: Node): Segment[] | null {
  switch (expr.type) {
    case "identifier":
      return [{ name: expr.text, typeArgs: [], args: [] }];
    case "exprDot": {
      const lhs = expr.childForFieldName("lhs");
      const rhs = expr.childForFieldName("rhs");
      if (!lhs || !rhs || rhs.type !== "identifier") return null;
      const left = flattenChain(lhs);
      return left ? [...left, { name: rhs.text, typeArgs: [], args: [] }] : null;
    }
    case "exprTpl": {
      const entity = expr.childForFieldName("entity");
      const segs = entity ? flattenChain(entity) : null;
      if (!segs) return null;
      segs[segs.length - 1]!.typeArgs = fieldChildren(expr, "args");
      return segs;
    }
    case "exprCall": {
      const entity = expr.childForFieldName("entity");
      const segs = entity ? flattenChain(entity) : null;
      if (!segs) return null;
      segs[segs.length - 1]!.args = callArgs(expr);
      return segs;
    }
    default:
      return null;
  }
}

/** `TypeInfo(IFoo)` → `IFoo` (the non-generic Spring4D spelling of a type argument). */
function typeInfoArg(node: Node | undefined): string | null {
  if (!node || node.type !== "exprCall") return null;
  const entity = node.child(0);
  if (!entity || entity.type !== "identifier" || entity.text.toLowerCase() !== "typeinfo") return null;
  const args = callArgs(node);
  return args.length === 1 ? args[0]!.text : null;
}

/** A type argument, generic (`<IFoo>`) or `TypeInfo(IFoo)`. */
function segmentType(seg: Segment, index = 0): string | null {
  return seg.typeArgs[index]?.text ?? typeInfoArg(seg.args[index]);
}

/**
 * The class an activator delegate returns: an anonymous function whose body
 * is exactly `Result := TFoo.Create(…)` (or `Exit(TFoo.Create(…))`). Anything
 * else is a decision the source does not make statically.
 */
function delegateClass(arg: Node | undefined): string | null {
  if (!arg || arg.type !== "lambda") return null;
  const body = arg.childForFieldName("body");
  if (!body) return null;
  const statements = body.namedChildren.filter((n) => n.type !== "comment" && !/^k[A-Z]/.test(n.type));
  if (statements.length !== 1) return null;
  const only = statements[0]!;
  if (only.type === "assignment") {
    const lhs = only.childForFieldName("lhs");
    const rhs = only.childForFieldName("rhs");
    if (!lhs || !rhs || lhs.text.toLowerCase() !== "result") return null;
    return constructedClass(rhs);
  }
  const call = only.type === "statement" ? only.child(0) : only;
  if (call?.type === "exprCall" && call.child(0)?.text.toLowerCase() === "exit") {
    const args = callArgs(call);
    return args.length === 1 ? constructedClass(args[0]!) : null;
  }
  return null;
}

/** Cheap whole-file gate before any statement is visited. */
const REGISTRATION_GATE_RE = /\bRegister(?:Type|Instance)\b/i;

/**
 * Spring4D container registrations → `FileAnalysis.diBindings`:
 *
 *   RegisterType<TSqlRepo>.Implements<IRepo>          IRepo → TSqlRepo
 *   RegisterType<IClock, TSystemClock>                IClock → TSystemClock
 *   RegisterType<TEmail>.Implements<INotifier>('email')   named: qualifier `email`, keyedOnly
 *   ….AsDefault / .AsDefault<INotifier>               primary (and reachable unnamed)
 *   RegisterType<INotifier>.DelegateTo(function: INotifier begin Result := TEmail.Create end)
 *   RegisterInstance<IClock>(TSystemClock.Create)     IClock → TSystemClock
 *   RegisterType(TypeInfo(TFoo)).Implements(TypeInfo(IFoo))
 *
 * `RegisterType<TFoo>` with no `Implements` registers every interface TFoo
 * implements, found by RTTI at run time — not decidable from the text, so it
 * is skipped; so are self registrations. Lifetime links (`AsSingleton`,
 * `AsTransient`, …) say nothing about the implementation and are ignored.
 */
export function pascalDiBindings(tree: Tree, sourceText: string, _filePath: string): DiBinding[] {
  if (!REGISTRATION_GATE_RE.test(sourceText)) return [];
  const out: DiBinding[] = [];
  for (const statement of tree.rootNode.descendantsOfType("statement")) {
    const expr = statement.child(0);
    if (!expr || (expr.type !== "exprTpl" && expr.type !== "exprCall" && expr.type !== "exprDot")) continue;
    if (!REGISTRATION_GATE_RE.test(expr.text)) continue;
    const chain = flattenChain(expr);
    if (!chain) continue;
    const at = chain.findIndex((s) => /^Register(?:Type|Instance)$/i.test(s.name));
    if (at < 0) continue;
    const line = statement.startPosition.row + 1;
    for (const b of registrationBindings(chain[at]!, chain.slice(at + 1))) out.push({ ...b, line });
  }
  return out;
}

function registrationBindings(head: Segment, rest: Segment[]): Omit<DiBinding, "line">[] {
  const via = /instance/i.test(head.name) ? "RegisterInstance" : "RegisterType";
  const services: Array<{ service: string; qualifier?: string }> = [];
  let implementation: string | null = null;
  // `RegisterType<IFoo>` + a delegate: the component type is the service the
  // delegate builds — unless `Implements` names the services itself.
  let componentService: string | null = null;
  const singleComponent = via === "RegisterType" && head.typeArgs.length < 2;

  if (via === "RegisterInstance") {
    // `RegisterInstance<TServiceType>(instance)`.
    const service = segmentType(head);
    if (service) services.push({ service });
    implementation = head.args[0] ? constructedClass(head.args[0]) : null;
  } else if (!singleComponent) {
    // `RegisterType<TServiceType, TComponentType>(['name'])`.
    const name = head.args[0]?.type === "literalString" ? unquote(head.args[0].text) : null;
    services.push(name ? { service: head.typeArgs[0]!.text, qualifier: name } : { service: head.typeArgs[0]!.text });
    implementation = head.typeArgs[1]!.text;
  } else {
    implementation = segmentType(head);
    const delegated = delegateClass(head.args.find((a) => a.type === "lambda"));
    if (delegated) {
      componentService = implementation;
      implementation = delegated;
    }
  }

  const primaryFor = new Set<string>();
  let primaryAll = false;
  for (const seg of rest) {
    const n = seg.name.toLowerCase();
    if (n === "implements") {
      const service = segmentType(seg);
      if (!service) continue;
      const nameArg = seg.args.find((a) => a.type === "literalString");
      const name = nameArg ? unquote(nameArg.text) : null;
      services.push(name ? { service, qualifier: name } : { service });
    } else if (n === "delegateto") {
      // A delegate that is not one plain construction builds something the
      // text does not say: the registration decides nothing.
      const delegated = delegateClass(seg.args[0]);
      if (!delegated) return [];
      if (singleComponent && !componentService) componentService = implementation;
      implementation = delegated;
    } else if (n === "asdefault") {
      const only = segmentType(seg);
      if (only) primaryFor.add(barePascalTypeName(only) ?? only);
      else primaryAll = true;
    }
  }
  if (services.length === 0 && componentService) services.push({ service: componentService });
  if (!implementation) return [];
  const impl = barePascalTypeName(implementation);
  if (!impl) return [];

  const out: Omit<DiBinding, "line">[] = [];
  for (const s of services) {
    const service = barePascalTypeName(s.service);
    if (!service || (service === impl && !s.qualifier)) continue;
    const b: Omit<DiBinding, "line"> = { service, implementation: impl, via };
    const primary = primaryAll || primaryFor.has(service);
    if (s.qualifier) {
      b.qualifier = s.qualifier;
      // A named registration answers only to its name — unless it is also
      // declared the default for the service.
      if (!primary) b.keyedOnly = true;
    }
    if (primary) b.primary = true;
    out.push(b);
  }
  return out;
}
