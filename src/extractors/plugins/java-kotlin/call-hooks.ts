import type { Node } from "web-tree-sitter";
import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { genericResolveCallName } from "../../shared/call-graph.js";
import { containerLookup, expressionFact } from "./di-expressions.js";

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
      return obj ? `${obj.text}.${nameNode.text}` : nameNode.text;
    }
  }
  if (node.type === "call_expression") {
    const callee = node.child(0);
    if (callee && (callee.type === "navigation_expression" || callee.type === "simple_identifier")) {
      // Collapse whitespace so a multiline fluent chain yields a clean dotted name.
      return callee.text.replace(/\s+/g, "");
    }
  }
  return genericResolveCallName(node);
}

/** Instance variable → imported type (userService → UserService). */
function capitalizedRoot(root: string): readonly string[] {
  return [root.charAt(0).toUpperCase() + root.slice(1)];
}

const JAVA_NESTED_SCOPE_TYPES = [
  "method_declaration", "constructor_declaration", "lambda_expression", "anonymous_class_body",
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
  return lookupType(recv);
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
  anonymousScopeTypes: ["lambda_expression"],
  callbackArgNodeTypes: ["method_invocation"],
  // A name the method binds itself is a value when passed as an argument,
  // not a callback reference (see CallExtractionHooks.bindingSites).
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
};

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
  resolveCallName: resolveJvmCallName,
  qualifiedRootCandidates: capitalizedRoot,
  receiverTypeOf: kotlinReceiverType,
};
