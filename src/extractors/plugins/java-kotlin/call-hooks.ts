import type { Node } from "web-tree-sitter";
import { jvmArgOriginsOf } from "./arg-origins.js";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { containerLookup, expressionFact } from "./di-expressions.js";
import { javaArgKinds, javaOverloadTypeKey, kotlinArgKinds, kotlinOverloadTypeKey } from "./arg-kinds.js";

/**
 * Resolve the qualified call name for both JVM grammars.
 *
 * Java `method_invocation` exposes `object` / `name` fields, so we keep the
 * qualifier ("userService.searchUsers", not just "searchUsers").
 *
 * Kotlin `call_expression` has NEITHER field — the callee is the first child:
 * a `navigation_expression` (`this.service.getGlobalVariables`) for a qualified
 * call, or a `simple_identifier` (`bar`) for an unqualified one. Without this,
 * every Kotlin `receiver.method()` call resolved to null → the call graph saw
 * only same-scope `foo()` calls and missed all cross-object edges
 * (controller→service→dao), so traces never reached the data layer.
 */
function resolveJvmCallName(node: Node): string | null {
  if (node.type === "method_invocation") {
    const nameNode = node.childForFieldName("name");
    const obj = node.childForFieldName("object");
    if (nameNode) {
      return obj ? `${compactChain(obj.text)}.${nameNode.text}` : nameNode.text;
    }
  }
  if (node.type === "call_expression") {
    const callee = node.child(0);
    if (callee && (callee.type === "navigation_expression" || callee.type === "simple_identifier")) {
      // Collapse whitespace so a multiline fluent chain yields a clean dotted name.
      // `this@ClubScreen.save()` names the labelled class's own member: `ClubScreen.save`.
      return compactChain(callee.text).replace(/\s+/g, "").replace(/^this@([A-Z]\w*)\.(\w+)$/, "$1.$2");
    }
  }
  return genericResolveCallName(node);
}

/**
 * A receiver chain with every argument list or trailing block that holds a
 * lambda or a block cut to `(…)` / `{…}`, and whitespace collapsed:
 * `repo.findById(id).filter(x -> { … }).map` names the call, not the 1,000
 * characters of the lambdas it was handed. Plain arguments stay as written.
 */
export function compactChain(text: string): string {
  if (!/->|\{/.test(text)) return text.replace(/\s*\n\s*/g, "");
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '"' || ch === "'") {
      // Copy a string or char literal as written.
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch !== "(" && ch !== "{") {
      out += ch;
      continue;
    }
    const close = ch === "(" ? ")" : "}";
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j]!;
      if (c === '"' || c === "'") {
        let k = j + 1;
        while (k < text.length && text[k] !== c) k += text[k] === "\\" ? 2 : 1;
        j = k;
      } else if (c === "(" || c === "{") depth++;
      else if (c === ")" || c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const inner = text.slice(i + 1, j);
    out += ch === "{" || /->|\{/.test(inner) ? `${ch}…${close}` : `${ch}${inner}${close}`;
    i = j;
  }
  return out.replace(/\s*\n\s*/g, "");
}

/** Instance variable → imported type (userService → UserService). */
function capitalizedRoot(root: string): readonly string[] {
  return [root.charAt(0).toUpperCase() + root.slice(1)];
}

const JAVA_NESTED_SCOPE_TYPES = [
  "method_declaration", "constructor_declaration", "lambda_expression",
];

/**
 * The receiver type a container lookup chained straight into the call names
 * (`ctx.getBean(Foo.class).build()`, `injector.getInstance(Key.get(Foo.class,
 * Names.named("n"))).quote()`, `((Foo) ctx.getBean("foo")).m()`) — the linker
 * resolves it like an injected field of that type. Called for every call node:
 * bails out on the receiver's node type before anything else. A construction
 * chained into a call (`new Foo().m()`) is NOT reported: an object built by
 * hand is not the one a container registration would substitute.
 */
function javaReceiverType(node: Node): { type: string; qualifier?: string } | null {
  const recv = node.children[0];
  if (!recv || (recv.type !== "method_invocation" && recv.type !== "parenthesized_expression")) return null;
  if (node.children[1]?.type !== ".") return null;
  return lookupType(recv) ?? proxyFactoryType(recv);
}

/**
 * The API interface a client-proxy factory chained straight into the call builds:
 * `JAXRSClientFactory.fromClient(client, ClubApi.class).getClub(id)`,
 * `RestClientBuilder.newBuilder()…build(ClubApi.class).getClub(id)`, Feign's `.target(ClubApi.class, url)`,
 * Retrofit's `retrofit.create(ClubApi.class)`. Core turns the call into a contract call when the type is a
 * registered proxy.
 */
function proxyFactoryType(recv: Node): { type: string } | null {
  if (recv.type !== "method_invocation") return null;
  const name = recv.childForFieldName("name")?.text ?? "";
  const object = recv.childForFieldName("object")?.text ?? "";
  const factory = (/^(?:create|fromClient)$/.test(name) && /(?:^|\.)JAXRSClientFactory$/.test(object))
    || (name === "build" && /RestClientBuilder\b/.test(object))
    || (name === "target" && /\bFeign\b/.test(object))
    || (name === "create" && /retrofit$/i.test(object));
  if (!factory) return null;
  const literal = recv.childForFieldName("arguments")?.namedChildren
    .map((a) => /^((?:[a-z_]\w*\.)*[A-Z]\w*)\.class$/.exec(a.text)?.[1])
    .find((t): t is string => !!t);
  return literal ? { type: literal } : null;
}

/** Kotlin: `ctx.getBean(Foo::class.java).m()`, `get<Foo>().m()`, `(ctx.getBean("n") as Foo).m()`. */
function kotlinReceiverType(node: Node): { type: string; qualifier?: string } | null {
  const callee = node.children[0];
  if (callee?.type !== "navigation_expression") return null;
  const recv = callee.children[0];
  if (!recv || (recv.type !== "call_expression" && recv.type !== "parenthesized_expression")) return null;
  return lookupType(recv);
}

function lookupType(recv: Node): { type: string; qualifier?: string } | null {
  const fact = recv.type === "parenthesized_expression" ? expressionFact(recv) : containerLookup(recv);
  if (!fact?.type || fact.constructed) return null;
  return fact.qualifier ? { type: fact.type, qualifier: fact.qualifier } : { type: fact.type };
}

export const javaCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["method_invocation", "object_creation_expression"]),
  nestedScopeTypes: JAVA_NESTED_SCOPE_TYPES,
  // A lambda passed as an argument (`orders.forEach(o -> repo.save(o))`,
  // `stream().map(x -> mapper.toDto(x))`) runs on behalf of the method that
  // wires it: its calls are the method's. A lambda bound to a local
  // (`Runnable r = () -> …`) stays a boundary (see call-graph.ts).
  // So does an anonymous class (`cache.get(new Task<Boolean>() { public
  // Boolean get() { return getService().find(id); } })`) or a local class: a
  // `class_body` met inside a method body is no member class, its methods are
  // no symbol of their own, and the method that builds it is where they run.
  anonymousScopeTypes: ["lambda_expression", "class_body"],
  // No `callbackArgNodeTypes`: a Java identifier handed to a call is always a
  // value — a method is passed as `this::save` (a method reference, below) —
  // so `execute(ruleUuid, slots)` never calls the record accessors `slots()`.
  // A name the method binds itself is a value when passed as an argument
  // (see CallExtractionHooks.bindingSites).
  bindingSites: {
    method_declaration: ["parameters"],
    constructor_declaration: ["parameters"],
    lambda_expression: ["parameters"],
    variable_declarator: ["name"],
    enhanced_for_statement: ["name"],
    catch_formal_parameter: ["name"],
    resource: ["name"],
  },
  bindingPatterns: {
    formal_parameters: ["*"],
    inferred_parameters: ["*"],
    formal_parameter: ["name"],
    spread_parameter: ["*"],
    variable_declarator: ["name"],
  },
  resolveCallName: resolveJvmCallName,
  qualifiedRootCandidates: capitalizedRoot,
  receiverTypeOf: javaReceiverType,
  argCountOf: javaArgCount,
  // What each argument is, so the linker tells overloads of one arity apart.
  argKindsOf: javaArgKinds,
  overloadTypeKey: javaOverloadTypeKey,
  argsOf: javaQueryNameArgs,
  // Where each argument comes from: a parameter, a request value, a literal.
  argOriginsOf: jvmArgOriginsOf,
  collectExtraCalls: javaMethodReference,
};

/**
 * A method reference is a call the stream or reactive chain makes on the
 * method's behalf: `.flatMap(postService::updatePost)` runs
 * `postService.updatePost(…)`, `.map(PostVo::from)` runs `PostVo.from(…)`,
 * `.map(Snapshot::new)` constructs a `Snapshot`. Without it a WebFlux handler
 * — which is nearly all method references — called nothing (Halo).
 */
function javaMethodReference(node: Node, addResult: (name: string, node: Node) => void): void {
  if (node.type !== "method_reference") return;
  const parts = node.namedChildren;
  const target = parts[0];
  const member = parts[parts.length - 1];
  if (!target || !member || target === member) {
    // `Snapshot::new` — the grammar has no name node for `new`.
    if (target && /::\s*new$/.test(node.text)) addResult(target.text.replace(/<.*>$/, ""), node);
    return;
  }
  if (/::\s*new$/.test(node.text)) {
    addResult(target.text.replace(/<.*>$/, ""), node);
    return;
  }
  addResult(`${target.text.replace(/\s+/g, "")}.${member.text}`, node);
}

/**
 * A callable reference as a handed-on name: `::save`, `Club::save`, `this::save` (the instance's own member),
 * `this@Club::save` (the labelled class's). `Club::class` is a class literal. The grammar reads `this::save`
 * as a navigation expression whose suffix is `::save`, every other head as a `callable_reference`.
 */
function kotlinReferenceName(ref: Node): { name: string; ownMember?: boolean } | null {
  if (ref.type !== "callable_reference" && !(ref.type === "navigation_expression" && ref.namedChildren[0]?.type === "this_expression")) return null;
  const m = /^(this(?:@[A-Z]\w*)?|[A-Z][\w.]*)?::([A-Za-z_]\w*)$/.exec(ref.text.replace(/\s+/g, ""));
  if (!m || m[2] === "class") return null;
  if (m[1] === "this") return { name: `this.${m[2]}`, ownMember: true };
  if (m[1]?.startsWith("this@")) return { name: `${m[1].slice(5)}.${m[2]}` };
  return { name: m[1] ? `${m[1]}.${m[2]}` : m[2]! };
}

/**
 * `register(::save)`, `bus.on(Club::save)`, `make(::Club)`, `bus.on(this::save)`: a function, constructor
 * or own member handed on by a callable reference.
 */
function kotlinCallableReferences(call: Node): Array<{ name: string; node: Node; ownMember?: boolean }> {
  const out: Array<{ name: string; node: Node; ownMember?: boolean }> = [];
  const suffix = call.namedChildren.find((c) => c.type === "call_suffix");
  const args = suffix?.namedChildren.find((c) => c.type === "value_arguments");
  for (const arg of args?.namedChildren ?? []) {
    const ref = arg.namedChildren.find((c) => c.type === "callable_reference" || c.type === "navigation_expression");
    const named = ref ? kotlinReferenceName(ref) : null;
    if (ref && named) out.push({ ...named, node: ref });
  }
  return out;
}

/** Infix functions the Kotlin standard library declares: `1 to 2`, `0 until n`, `a shl 2`, `x and y`. */
const KOTLIN_STDLIB_INFIX = new Set(["to", "until", "downTo", "step", "shl", "shr", "ushr", "and", "or", "xor", "zip", "compareTo", "rem", "mod", "div", "times", "plus", "minus", "onEach", "matches", "contentEquals", "eq"]);

/**
 * `club scores goal` calls `club.scores(goal)` when `scores` is declared `infix`: the call is named as the
 * dotted one, which the linker resolves on the receiver's type or drops. A standard-library infix is no call.
 */
function kotlinInfixCall(node: Node): string | null {
  const [left, op] = node.namedChildren;
  if (!left || op?.type !== "simple_identifier" || KOTLIN_STDLIB_INFIX.has(op.text)) return null;
  const receiver = left.text.replace(/\s+/g, "");
  return /^(?:this|[A-Za-z_]\w*)(?:\.[A-Za-z_]\w*)*$/.test(receiver) ? `${receiver}.${op.text}` : null;
}

/** A callable reference kept in a value (`val on = this::save`, `return ::saveClub`) is handed on too; an argument is `passedArguments`'. */
function kotlinStoredReference(node: Node, addResult: (name: string, node: Node, passed?: "attribute" | "return" | "property") => void): void {
  if (node.type === "infix_expression") {
    const infix = kotlinInfixCall(node);
    if (infix) addResult(infix, node);
    return;
  }
  if ((node.type !== "callable_reference" && node.type !== "navigation_expression") || node.parent?.type === "value_argument") return;
  const named = kotlinReferenceName(node);
  if (named) addResult(named.name, node, "attribute");
}

export const kotlinCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["call_expression"]),
  // No nested scopes: Kotlin lambdas and anonymous functions have no symbol
  // of their own (`list.forEach { repo.save(it) }` is the enclosing
  // function's call), and the plugin extracts no local `fun`s or
  // object-literal members, so every walk descends into all of them. (Listing
  // `lambda_literal` here — even as an anonymous scope — would stop the
  // file-level `<setup>` walk at `object X { val dao = run { … } }`, whose
  // calls belong to no extracted member.)
  nestedScopeTypes: [],
  callbackArgNodeTypes: ["call_expression"],
  passedArguments: kotlinCallableReferences,
  collectExtraCalls: kotlinStoredReference,
  resolveCallName: resolveJvmCallName,
  qualifiedRootCandidates: capitalizedRoot,
  receiverTypeOf: kotlinReceiverType,
  argCountOf: kotlinArgCount,
  argKindsOf: kotlinArgKinds,
  overloadTypeKey: kotlinOverloadTypeKey,
  // Where each argument comes from (named arguments by name).
  argOriginsOf: jvmArgOriginsOf,
  // `with(car) { wash() }` / `Car().apply { wash() }`: the lambda's receiver owns a bare name first.
  withSubjectsOf: kotlinImplicitReceivers,
};

/**
 * The receivers of the scope lambdas (`with(x) { }`, `x.apply { }`, `x.run { }`) a bare call sits in, innermost
 * first, as the linker reads a subject: a name chain (`car`, `this.car`), or the class a construction names
 * (`Car()` → `Car`). Null for a qualified call, and for a receiver that says no type.
 */
function kotlinImplicitReceivers(node: Node): string[] | null {
  if (node.type !== "call_expression" || node.child(0)?.type !== "simple_identifier") return null;
  const out: string[] = [];
  for (let p: Node | null = node.parent; p && p.type !== "function_declaration" && p.type !== "class_declaration"; p = p.parent) {
    if (p.type !== "lambda_literal") continue;
    const call = p.parent?.type === "annotated_lambda" ? p.parent.parent?.parent : null;
    if (call?.type !== "call_expression") continue;
    const callee = call.child(0);
    let subject: Node | null | undefined = null;
    if (callee?.type === "call_expression" && callee.child(0)?.text === "with") {
      // `with(car) { … }`: the lambda trails the call `with(car)`.
      subject = callee.children.find((c) => c.type === "call_suffix")?.namedChildren.find((c) => c.type === "value_arguments")?.namedChildren[0]?.namedChildren.slice(-1)[0];
    } else if (callee?.type === "navigation_expression") {
      const last = callee.namedChildren[callee.namedChildCount - 1];
      const method = last?.type === "navigation_suffix" ? last.namedChildren.find((c) => c.type === "simple_identifier")?.text : undefined;
      if (method === "apply" || method === "run") subject = callee.child(0);
    }
    const text = subject ? receiverSubject(subject) : null;
    if (text) out.push(text);
  }
  return out.length > 0 ? out : null;
}

/** `car` / `league.car` → itself; `Car(...)` → `Car`; anything else null. */
function receiverSubject(node: Node): string | null {
  if (node.type === "simple_identifier") return node.text;
  if (node.type === "navigation_expression" && /^[\w.]+$/.test(node.text.replace(/\s+/g, ""))) return node.text.replace(/\s+/g, "");
  if (node.type === "call_expression" && node.child(0)?.type === "simple_identifier" && /^[A-Z]/.test(node.child(0)!.text)) return node.child(0)!.text;
  return null;
}

/** A string literal shaped like a query name (`"match.by.club"`, `"Club.findAll"`): dotted, no spaces. */
const QUERY_NAME_LITERAL = /^"[A-Za-z][\w-]*(?:\.[\w-]+)+"$/;

/** A write a generic DAO method may perform for whatever it is handed (`create(entity)`, `saveOrUpdate(entity)`). */
const CRUD_METHOD = /^(?:create|update|delete|save|persist|merge|remove|insert|store|upsert)(?:[A-Z]\w*)?$/;

/**
 * The arguments of a call handing over a named query's name — a DAO helper
 * (`list("match.by.club", club)`) that runs `createNamedQuery(name)` for it —
 * so the JVM entity pass can tell which query runs there; and of a CRUD-named
 * call on an object handed one variable (`change.create(address)`), so the pass
 * can type a generic DAO method (`<T> T create(T entity)`) by what its callers
 * hand it. Other calls keep none.
 */
function javaQueryNameArgs(node: Node): string[] | null {
  if (node.type !== "method_invocation") return null;
  const args = node.childForFieldName("arguments")?.namedChildren.filter((c): c is Node => !!c && !/comment$/.test(c.type)) ?? [];
  const named = args.some((a) => a.type === "string_literal" && QUERY_NAME_LITERAL.test(a.text));
  const handed = args.length === 1 && args[0]!.type === "identifier" && !!node.childForFieldName("object") &&
    CRUD_METHOD.test(node.childForFieldName("name")?.text ?? "");
  // A class's own event helper handed the event (`emitSubEntity(address, event)`): the
  // entity pass types the helper's publish by what each caller hands it.
  const object = node.childForFieldName("object");
  const helper = (!object || object.type === "this" || object.type === "super") && args.length > 0 &&
    EVENT_HELPER_METHOD.test(node.childForFieldName("name")?.text ?? "");
  if (!named && !handed && !helper) return null;
  return args.map((a) => a.text.replace(/\s+/g, " "));
}

/** A helper named for publishing (`emit`, `emitSubEntity`, `publishCreated`, `fireEvent`). */
const EVENT_HELPER_METHOD = /^(?:emit|publish|fire|raise|dispatch)(?:[A-Z]\w*)?$/;

/** A Java call's argument count: the `argument_list`'s expressions. */
function javaArgCount(node: Node): number | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  return args.namedChildren.filter((c) => c.type !== "line_comment" && c.type !== "block_comment").length;
}

/**
 * A Kotlin call's argument count: its `value_argument`s plus a trailing lambda.
 * A spread (`*items`) passes any number, so it makes the count unknown.
 */
function kotlinArgCount(node: Node): number | null {
  // `save(o) { … }` parses as a call of the call `save(o)` with the lambda:
  // the outer node is that same call, and the inner one counts its lambda.
  if (node.child(0)?.type === "call_expression") return null;
  const suffixes = node.children.filter((c) => c.type === "call_suffix");
  const outer = node.parent?.type === "call_expression" && node.parent.child(0)?.id === node.id ? node.parent : null;
  for (const c of outer?.children ?? []) if (c.type === "call_suffix") suffixes.push(c);
  if (suffixes.length === 0) return null;
  let n = 0;
  for (const part of suffixes.flatMap((s) => s.children)) {
    if (part.type === "annotated_lambda") n++;
    else if (part.type === "value_arguments") {
      for (const arg of part.namedChildren) {
        if (arg.type !== "value_argument") continue;
        if (arg.text.trimStart().startsWith("*")) return null;
        n++;
      }
    }
  }
  return n;
}
