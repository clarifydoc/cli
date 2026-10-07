import type { Node, Tree } from "web-tree-sitter";
import { classRefName, constantString, simpleName } from "./di-annotations.js";

/**
 * What an expression evaluates to, when the expression itself says so — the
 * facts the DI channel needs from initializers and receivers:
 *
 *   construction       Java `new Foo(..)`, Kotlin `Foo(..)` / `com.x.Foo(..)` / `Foo(..).apply { }`
 *   container lookup   Spring `getBean(Foo.class)` / `getBean("n", Foo.class)` / `getBean<Foo>()`,
 *                      Guice `getInstance(Foo.class)` / `getInstance(Key.get(Foo.class, Names.named("n")))`,
 *                      Koin `get<Foo>()` / `get<Foo>(named("n"))` / `getOrNull<Foo>()`
 *   cast               `(Foo) ctx.getBean("n")`, `ctx.getBean("n") as Foo`
 *
 * A lookup's key (`"n"`, `named("n")`) is reported as `qualifier`; a lookup
 * by key alone (`ctx.getBean("n")`) has a qualifier and no type.
 */
export interface ExprFact {
  type?: string;
  qualifier?: string;
  /** The value is a construction of `type` (not a container lookup). */
  constructed?: boolean;
  /** Java anonymous subclass (`new Foo() { … }`): the object is not a `Foo` the container could name. */
  anonymous?: boolean;
}

/** Container-lookup method names, by grammar. */
const JAVA_LOOKUPS: ReadonlySet<string> = new Set(["getBean", "getInstance"]);
const KOTLIN_LOOKUPS: ReadonlySet<string> = new Set(["getBean", "getInstance", "get", "getOrNull"]);
/** Kotlin scope functions that return their receiver (`Foo().apply { … }` is a `Foo`). */
const RETURNS_RECEIVER: ReadonlySet<string> = new Set(["apply", "also"]);

/**
 * Upper-case names a Kotlin file declares as functions (`fun Text(..)`,
 * Compose-style): a call of one is a function call, not a construction.
 * Read off the source text once per tree (a regex, no walk).
 */
const capitalizedFns = new WeakMap<Tree, ReadonlySet<string>>();
export function kotlinCapitalizedFunctions(node: Node): ReadonlySet<string> {
  const tree = node.tree;
  let names = capitalizedFns.get(tree);
  if (!names) {
    const found = new Set<string>();
    const re = /\bfun\s+(?:<[^>\n]*>\s*)?(?:[\w.]+\.)?([A-Z]\w*)\s*\(/g;
    for (const m of tree.rootNode.text.matchAll(re)) found.add(m[1]!);
    names = found;
    capitalizedFns.set(tree, names);
  }
  return names;
}

/** What `node` evaluates to, or null when the expression does not say. */
export function expressionFact(node: Node | null | undefined): ExprFact | null {
  if (!node) return null;
  switch (node.type) {
    case "parenthesized_expression":
      return expressionFact(node.namedChildren[0]);
    case "object_creation_expression": {
      const t = node.childForFieldName("type");
      const type = t ? simpleName(t.text) : null;
      if (!type) return null;
      const fact: ExprFact = { type, constructed: true };
      if (node.children.some((c) => c.type === "class_body")) fact.anonymous = true;
      return fact;
    }
    case "cast_expression": {
      const type = simpleName(node.childForFieldName("type")?.text ?? "");
      if (!type) return null;
      const inner = containerLookup(node.childForFieldName("value"));
      return inner?.qualifier ? { type, qualifier: inner.qualifier } : { type };
    }
    case "as_expression": {
      const typeNode = node.namedChildren[node.namedChildren.length - 1];
      const type = typeNode && typeNode.type !== "as_expression" ? simpleName(typeNode.text) : null;
      if (!type) return null;
      const inner = containerLookup(node.namedChildren[0]);
      return inner?.qualifier ? { type, qualifier: inner.qualifier } : { type };
    }
    case "method_invocation":
      return containerLookup(node);
    case "call_expression":
      return containerLookup(node) ?? kotlinConstruction(node);
  }
  return null;
}

/**
 * A container lookup: the type it asks for and the key it names. Java
 * `method_invocation` / Kotlin `call_expression` only; null for any other
 * call (bails out on the method name before looking at arguments).
 */
export function containerLookup(node: Node | null | undefined): ExprFact | null {
  if (!node) return null;
  if (node.type === "method_invocation") {
    const name = node.childForFieldName("name")?.text;
    if (!name || !JAVA_LOOKUPS.has(name)) return null;
    const args = node.childForFieldName("arguments")?.namedChildren.filter(isExpression) ?? [];
    return lookupFromArgs(name, args, [], "java");
  }
  if (node.type === "call_expression") {
    const callee = node.children[0];
    if (!callee) return null;
    const name = calleeName(callee);
    if (!name || !KOTLIN_LOOKUPS.has(name)) return null;
    const suffix = node.children.find((c) => c.type === "call_suffix");
    if (!suffix) return null;
    const typeArgs = suffix.children.find((c) => c.type === "type_arguments");
    const typeArg = typeArgs?.namedChildren.find((c) => c.type === "type_projection")?.namedChildren[0];
    const args = (suffix.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [])
      .filter((v) => v.type === "value_argument")
      .map((v) => v.namedChildren[v.namedChildren.length - 1]!)
      .filter(Boolean);
    const typeArgNames = typeArg ? [simpleName(typeArg.text)].filter((n): n is string => !!n) : [];
    return lookupFromArgs(name, args, typeArgNames, "kotlin");
  }
  return null;
}

/** `getBean` / `getInstance` / `get` arguments → requested type + key. */
function lookupFromArgs(name: string, args: Node[], typeArgs: string[], lang: "java" | "kotlin"): ExprFact | null {
  const fact: ExprFact = {};
  if (typeArgs[0]) fact.type = typeArgs[0];
  if (name === "getBean") {
    // getBean(Foo.class) / getBean(Foo.class, args…) / getBean("name") / getBean("name", Foo.class) / getBean<Foo>("name")
    const first = args[0];
    if (first) {
      const cls = classRefName(first);
      if (cls) fact.type ??= cls;
      else {
        const key = constantString(first);
        if (key !== null) fact.qualifier = key;
        const second = args[1] ? classRefName(args[1]) : null;
        if (second) fact.type ??= second;
      }
    }
  } else if (name === "getInstance") {
    // Guice: getInstance(Foo.class) / getInstance(Key.get(Foo.class[, qualifier]))
    if (args.length !== 1) return null;
    const cls = classRefName(args[0]!) ?? null;
    if (cls) fact.type ??= cls;
    else {
      const key = guiceKey(args[0]!);
      if (!key) return null;
      fact.type ??= key.type;
      if (key.qualifier) fact.qualifier = key.qualifier;
    }
  } else {
    // Koin get<Foo>() / get<Foo>(named("n")) / get(Foo::class) — only with a
    // type argument or a class reference: `map.get(k)` says nothing.
    if (lang !== "kotlin") return null;
    for (const a of args) {
      const cls = classRefName(a);
      if (cls && !fact.type) { fact.type = cls; continue; }
      const q = koinQualifier(a);
      if (q) fact.qualifier = q;
    }
  }
  return fact.type || fact.qualifier ? fact : null;
}

/** Guice `Key.get(Foo.class)` / `Key.get(Foo.class, Names.named("n"))` / `Key.get(Foo.class, Fast.class)`. */
export function guiceKey(node: Node): { type: string; qualifier?: string } | null {
  const isKeyGet =
    (node.type === "method_invocation" && node.childForFieldName("object")?.text === "Key" && node.childForFieldName("name")?.text === "get") ||
    (node.type === "call_expression" && node.children[0]?.text.replace(/\s+/g, "") === "Key.get");
  if (!isKeyGet) return null;
  const args = callArguments(node);
  const type = args[0] ? classRefName(args[0]) : null;
  if (!type) return null;
  const q = args[1] ? guiceQualifier(args[1]) : null;
  return q ? { type, qualifier: q } : { type };
}

/** A Guice binding annotation argument: `Names.named("x")` → `x`, `Fast.class` → `Fast`. */
export function guiceQualifier(node: Node): string | null {
  const cls = classRefName(node);
  if (cls) return cls;
  const name = calleeOrMethodName(node);
  if (name === "named") {
    const arg = callArguments(node)[0];
    return arg ? constantString(arg) : null;
  }
  return null;
}

/** Koin `named("x")` → `x`; `named<Foo>()` → `Foo`. Null for anything else. */
export function koinQualifier(node: Node): string | null {
  if (node.type !== "call_expression") return null;
  if (calleeOrMethodName(node) !== "named") return null;
  const suffix = node.children.find((c) => c.type === "call_suffix");
  const typeArg = suffix?.children.find((c) => c.type === "type_arguments")?.namedChildren[0]?.namedChildren[0];
  if (typeArg) return simpleName(typeArg.text);
  const arg = callArguments(node)[0];
  return arg ? constantString(arg) : null;
}

/** Argument expressions of a Java `method_invocation` or Kotlin `call_expression`. */
export function callArguments(node: Node): Node[] {
  if (node.type === "method_invocation" || node.type === "object_creation_expression") {
    return node.childForFieldName("arguments")?.namedChildren.filter(isExpression) ?? [];
  }
  if (node.type === "call_expression") {
    const suffix = node.children.find((c) => c.type === "call_suffix");
    return (suffix?.children.find((c) => c.type === "value_arguments")?.namedChildren ?? [])
      .filter((v) => v.type === "value_argument")
      .map((v) => v.namedChildren[v.namedChildren.length - 1]!)
      .filter(Boolean);
  }
  return [];
}

/** The method name of a Java `method_invocation` or the callee leaf of a Kotlin `call_expression`. */
export function calleeOrMethodName(node: Node): string | null {
  if (node.type === "method_invocation") return node.childForFieldName("name")?.text ?? null;
  if (node.type === "call_expression") {
    const callee = node.children[0];
    return callee ? calleeName(callee) : null;
  }
  return null;
}

/** Leaf name of a Kotlin callee: `get` for `get`, `getBean` for `ctx.getBean`. */
function calleeName(callee: Node): string | null {
  if (callee.type === "simple_identifier") return callee.text;
  if (callee.type === "navigation_expression") {
    const suffix = callee.children[callee.children.length - 1];
    const id = suffix?.type === "navigation_suffix" ? suffix.children.find((c) => c.type === "simple_identifier") : null;
    return id?.text ?? null;
  }
  return null;
}

/**
 * A Kotlin construction: a call of an upper-case name with an argument list
 * (`Foo(..)`, `com.x.Foo(..)`, `Outer.Inner(..)`) that the file does not
 * declare as a function, or `Foo(..).apply { }` / `.also { }`. Kotlin's
 * factory functions are conventionally named after the type they return
 * (`HttpClient(CIO)`, `MutableStateFlow(x)`), so the name is the type either way.
 */
export function kotlinConstruction(node: Node): ExprFact | null {
  if (node.type !== "call_expression") return null;
  const callee = node.children[0];
  const suffix = node.children[1];
  if (!callee || suffix?.type !== "call_suffix") return null;
  if (callee.type === "navigation_expression") {
    // `Foo(..).apply { … }` returns the receiver.
    const head = callee.children[0];
    const leaf = calleeName(callee);
    if (head?.type === "call_expression" && leaf && RETURNS_RECEIVER.has(leaf)) return kotlinConstruction(head);
    const text = callee.text.replace(/\s+/g, "");
    if (!/^[A-Za-z_][\w.]*$/.test(text)) return null;
    const last = text.split(".").pop()!;
    if (!/^[A-Z]/.test(last)) return null;
    if (!suffix.children.some((c) => c.type === "value_arguments")) return null;
    return { type: last, constructed: true };
  }
  if (callee.type !== "simple_identifier" || !/^[A-Z]/.test(callee.text)) return null;
  if (!suffix.children.some((c) => c.type === "value_arguments")) return null;
  if (kotlinCapitalizedFunctions(node).has(callee.text)) return null;
  return { type: callee.text, constructed: true };
}

function isExpression(n: Node): boolean {
  return n.type !== "line_comment" && n.type !== "block_comment";
}
