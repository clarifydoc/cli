import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";
import { calleeName, isShortFunction, MODULE_NODES, params, signatureCall } from "./syntax.js";

/**
 * Julia functions and types: `function f(x::T)::R … end`, the short form
 * `f(x) = …`, `macro m(…)` (named `@m`), all at module level; `struct` /
 * `mutable struct` (`A <: B` names the supertype; typed fields are
 * properties) and `abstract type T end` (an interface in all but name —
 * methods dispatch on it). A method of a type is a function whose argument
 * is typed with it (multiple dispatch), so functions stay functions.
 */
export class JuliaExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["julia"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.namedChildren) {
      if (MODULE_NODES.has(child.type)) { this.collectFunctions(child, functions); continue; }
      if (child.type === "function_definition" || child.type === "macro_definition") {
        const call = signatureCall(child.namedChildren.find((c) => c.type === "signature"));
        const name = calleeName(call?.namedChildren[0]);
        if (!call || !name) continue;
        const sig = child.namedChildren.find((c) => c.type === "signature");
        const returnType = sig?.namedChildren[0]?.type === "typed_expression" ? sig.namedChildren[0].namedChildren[1]?.text ?? null : null;
        functions.push(fn(child.type === "macro_definition" ? `@${name}` : name, call, child, child, returnType));
      } else if (isShortFunction(child)) {
        const call = signatureCall(child.namedChildren[0])!;
        const name = calleeName(call.namedChildren[0]);
        const body = child.namedChildren[child.namedChildren.length - 1];
        if (name && body) functions.push(fn(name, call, body, child, null));
      }
    }
  }

  protected collectClasses(node: Node, classes: ClassInfo[]): void {
    for (const child of node.namedChildren) {
      if (MODULE_NODES.has(child.type)) { this.collectClasses(child, classes); continue; }
      if (child.type !== "struct_definition" && child.type !== "abstract_definition") continue;
      const head = child.namedChildren.find((c) => c.type === "type_head")?.namedChildren[0];
      if (!head) continue;
      const subtype = head.type === "binary_expression" && head.namedChildren.some((c) => c.type === "operator" && c.text === "<:");
      const nameNode = subtype ? head.namedChildren[0]! : head;
      const name = calleeName(nameNode) ?? nameNode.text.replace(/\{.*$/, "");
      const cls: ClassInfo = {
        name,
        extends: subtype ? calleeName(head.namedChildren[head.namedChildren.length - 1]) : null,
        implements: [],
        decorators: [],
        methods: [],
        properties: child.namedChildren
          .filter((c) => c.type === "typed_expression" || c.type === "identifier")
          .map((c) => ({
            name: c.type === "identifier" ? c.text : c.namedChildren[0]!.text,
            type: c.type === "identifier" ? null : c.namedChildren[1]?.text ?? null,
            visibility: "public" as const,
            isStatic: false,
            isReadonly: !/^\s*mutable\b/.test(child.text.slice(0, 20)),
          })),
        isExported: true,
        line: child.startPosition.row + 1,
        endLine: child.endPosition.row + 1,
      };
      if (child.type === "abstract_definition") cls.kind = "interface";
      classes.push(cls);
    }
  }
}

function fn(name: string, call: Node, body: Node, span: Node, returnType: string | null): FunctionInfo {
  return {
    name,
    params: params(call),
    returnType,
    isAsync: false,
    isExported: !name.startsWith("_"),
    decorators: [],
    calls: extractCalls(body, "julia"),
    line: span.startPosition.row + 1,
    endLine: span.endPosition.row + 1,
  };
}
