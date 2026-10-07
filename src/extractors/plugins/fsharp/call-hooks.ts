import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { calleeName, isFunctionDefn } from "./syntax.js";

/** Operators whose right operand is a function the pipeline invokes: `x |> save`, `GET >=> handler`. */
const PIPE_OPS = new Set(["|>", "||>", "|||>", ">=>", ">>"]);

/**
 * F# calls are function applications (`repo.Find id`, `json o next ctx`,
 * `ctx.GetService<T>()`). A curried application nests (`f a b` is
 * app(app(f, a), b)): only the innermost names the callee, so an outer one
 * reports nothing. A function piped into or composed with (`|> save`,
 * `>=> handler`) is called too.
 */
export const fsharpCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["application_expression"]),
  nestedScopeTypes: ["type_definition"],
  isFunctionDefinition: isFunctionDefn,
  resolveCallName(node) {
    const fn = node.namedChildren[0];
    if (!fn || fn.type === "application_expression") return null;
    return calleeName(fn);
  },
  collectExtraCalls(node, add) {
    if (node.type !== "infix_expression") return;
    const op = node.namedChildren.find((c) => c.type === "infix_op")?.text;
    if (!op || !PIPE_OPS.has(op)) return;
    const right = node.namedChildren[node.namedChildren.length - 1];
    const name = right && (right.type === "long_identifier_or_op" ? calleeName(right) : null);
    if (name && !/^[A-Z]+$/.test(name)) add(name, right!);
  },
};
