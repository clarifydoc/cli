import type { CallExtractionHooks } from "../../../types/language-plugin.js";
import { isFunctionBinding, valuePath } from "./syntax.js";

/**
 * An OCaml call is an application (`Db.find ~id`, `f x y`), or a function
 * applied through an operator: the right side of `x |> f`, the left of
 * `f @@ x`. A lambda (`fun req -> …`, `function …`) is a closure: inside a
 * function its calls are the function's, at module level it runs later (a
 * Dream handler), never at load. A function `let` ends the module-level walk.
 */
export const ocamlCallHooks: CallExtractionHooks = {
  callNodeTypes: new Set(["application_expression", "infix_expression"]),
  nestedScopeTypes: ["fun_expression", "function_expression", "class_definition", "module_type_definition"],
  anonymousScopeTypes: ["fun_expression", "function_expression"],
  isFunctionDefinition: isFunctionBinding,
  // `Db.find id` names its receiver: a module, never a value — the call is
  // on that module (the file `db.ml`, or a library's), so a leaf that reads
  // as a collection method elsewhere (`find`, `map`) is still a call.
  receiverTypeOf(node) {
    const fn = node.type === "application_expression" ? node.childForFieldName("function")
      : node.childForFieldName("operator")?.text === "|>" ? node.childForFieldName("right")
      : node.childForFieldName("operator")?.text === "@@" ? node.childForFieldName("left") : null;
    const path = valuePath(fn);
    const dot = path ? path.lastIndexOf(".") : -1;
    return path && dot > 0 && /^[A-Z]/.test(path) ? { type: path.slice(0, dot) } : null;
  },
  resolveCallName(node) {
    if (node.type === "application_expression") return valuePath(node.childForFieldName("function"));
    const op = node.childForFieldName("operator")?.text;
    if (op === "|>") return valuePath(node.childForFieldName("right"));
    if (op === "@@") return valuePath(node.childForFieldName("left"));
    return null;
  },
};

