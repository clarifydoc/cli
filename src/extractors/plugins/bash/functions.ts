import type { Node } from "web-tree-sitter";
import { FunctionClassExtractor } from "../../functions-classes/base.js";
import type { FunctionInfo, ClassInfo, Language } from "../../functions-classes/base.js";
import { extractCalls } from "../../shared/call-graph.js";

/**
 * Shell functions — `deploy() { … }`, `function rollback { … }`, a subshell
 * body `f() ( … )` — wherever they are defined (a function defined inside an
 * `if` is still the script's). Their arguments are positional (`$1`), so no
 * parameters are declared; a shell has no classes.
 */
export class BashFunctionExtractor extends FunctionClassExtractor {
  readonly languages: Language[] = ["bash"];

  protected collectFunctions(node: Node, functions: FunctionInfo[]): void {
    for (const child of node.namedChildren) {
      if (child.type === "function_definition") {
        const body = child.childForFieldName("body");
        functions.push({
          name: child.childForFieldName("name")?.text ?? "anonymous",
          params: [],
          returnType: null,
          isAsync: false,
          isExported: true,
          decorators: [],
          calls: extractCalls(body, "bash"),
          line: child.startPosition.row + 1,
          endLine: child.endPosition.row + 1,
        });
      }
      this.collectFunctions(child, functions);
    }
  }

  protected collectClasses(_node: Node, _classes: ClassInfo[]): void {}
}
