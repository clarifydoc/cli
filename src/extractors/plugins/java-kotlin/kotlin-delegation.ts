import type { Node } from "web-tree-sitter";
import type { CallInfo } from "../../../types/analysis.js";
import { kotlinArgKind } from "./arg-kinds.js";

/**
 * Kotlin constructor delegation as constructions, the way Java's `this(…)`/`super(…)` are: the primary
 * constructor of `class Derived(x: Int) : Base(x)` runs `Base`'s, and a secondary `constructor(…) : this(…)` /
 * `: super(…)` runs the same class's or the superclass's. Each is a call named `new Club` / `new Base` that the
 * linker settles by argument kinds, so it lands on the declared constructor (or the class when none is).
 */

function argumentsOf(args: Node | null | undefined): { argCount?: number; argKinds?: string[] } {
  if (!args) return {};
  const kinds: string[] = [];
  for (const arg of args.namedChildren) {
    if (arg.type !== "value_argument") continue;
    // A spread passes any number, a named argument any order: the count and kinds are unknown.
    if (arg.text.trimStart().startsWith("*")) return {};
    const expr = arg.namedChildren[arg.namedChildCount - 1];
    kinds.push(arg.children.some((c) => c.type === "=") ? "?" : expr ? kotlinArgKind(expr) : arg.text.trim() === "null" ? "null" : "?");
  }
  const named = args.namedChildren.some((a) => a.type === "value_argument" && a.children.some((c) => c.type === "="));
  return { argCount: kinds.length, ...(!named && kinds.some((k) => k !== "?") ? { argKinds: kinds } : {}) };
}

function constructionAt(name: string, at: Node, args: Node | null | undefined): CallInfo {
  return { name: `new ${name}`, kind: "internal", target: null, line: at.startPosition.row + 1, column: at.startPosition.column, ...argumentsOf(args) };
}

const typeNameOf = (t: Node | undefined): string | null => {
  const text = t?.text.replace(/<[\s\S]*$/, "").replace(/\s+/g, "");
  return text && /^[\w.]+$/.test(text) ? text : null;
};

/** The `Base(…)` a class header names as its superclass: the one delegation specifier that constructs. */
export function kotlinSuperConstruction(cls: Node): CallInfo | null {
  for (const spec of cls.children) {
    if (spec.type !== "delegation_specifier") continue;
    const ctor = spec.children.find((c) => c.type === "constructor_invocation");
    if (!ctor) continue;
    const name = typeNameOf(ctor.children.find((c) => c.type === "user_type"));
    return name ? constructionAt(name, ctor, ctor.children.find((c) => c.type === "value_arguments")) : null;
  }
  return null;
}

/** A secondary constructor's `: this(…)` / `: super(…)`. */
export function kotlinDelegationCall(ctor: Node): CallInfo | null {
  const call = ctor.children.find((c) => c.type === "constructor_delegation_call");
  const cls = ctor.parent?.parent;
  if (!call || !cls || cls.type !== "class_declaration") return null;
  const keyword = call.children.find((c) => c.type === "this" || c.type === "super")?.type;
  const args = call.children.find((c) => c.type === "value_arguments");
  if (keyword === "this") {
    const name = cls.children.find((c) => c.type === "type_identifier")?.text;
    return name ? constructionAt(name, call, args) : null;
  }
  if (keyword !== "super") return null;
  const header = kotlinSuperConstruction(cls);
  if (header) return { ...constructionAt(header.name.slice(4), call, args) };
  // `class Derived : Base { constructor(…) : super(…) }` — no primary constructor, so the header names a bare type.
  if (cls.children.some((c) => c.type === "primary_constructor")) return null;
  const specs = cls.children.filter((c) => c.type === "delegation_specifier");
  const only = specs.length === 1 ? specs[0]!.children.find((c) => c.type === "user_type") : undefined;
  const name = typeNameOf(only);
  return name ? constructionAt(name, call, args) : null;
}
