import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";
import { DataMutationExtractor } from "./base.js";

export class JavaKotlinMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    if (node.type === "method_invocation" || node.type === "call_expression") {
      const fnNode =
        node.childForFieldName("name") ?? node.childForFieldName("function");
      const fnName = fnNode?.text;

      if (fnName) {
        // Repository/database writes
        if (
          fnName === "save" ||
          fnName === "saveAll" ||
          fnName === "delete" ||
          fnName === "deleteById" ||
          fnName === "update" ||
          fnName === "insert" ||
          fnName === "persist" ||
          fnName === "merge" ||
          fnName === "flush"
        ) {
          mutations.push({
            kind: "db-write",
            target: node.text.length > 100 ? fnName : node.text,
            value: null,
            line: node.startPosition.row + 1,
          });
        }

        // Setter methods (setXxx pattern)
        if (/^set[A-Z]/.test(fnName)) {
          mutations.push({
            kind: "assignment",
            target: fnName,
            value: null,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    // Assignment expressions: this.field = value
    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      if (left) {
        const leftText = left.text;
        if (leftText.startsWith("this.") || leftText.includes(".")) {
          const right = node.childForFieldName("right");
          mutations.push({
            kind: "assignment",
            target: leftText,
            value: this.truncate(right?.text ?? null, 80),
            line: node.startPosition.row + 1,
          });
        }
      }
    }
  }
}
