import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";
import { DataMutationExtractor } from "./base.js";

export class PythonMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["python"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // self.xxx = yyy
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.text.startsWith("self.")) {
        const right = node.childForFieldName("right");
        mutations.push({
          kind: "assignment",
          target: left.text,
          value: this.truncate(right?.text ?? null, 80),
          line: node.startPosition.row + 1,
        });
      }
    }

    // db.session.add/commit/delete patterns
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      if (fn?.text) {
        const text = fn.text;
        if (
          text.includes(".add") ||
          text.includes(".commit") ||
          text.includes(".delete") ||
          text.includes(".save") ||
          text.includes(".update")
        ) {
          if (
            text.includes("session") ||
            text.includes("db") ||
            text.includes("model")
          ) {
            mutations.push({
              kind: "db-write",
              target: text,
              value: null,
              line: node.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}
