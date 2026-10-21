import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";
import { callArguments, resolveCall } from "./data-sources.js";

/**
 * Kotlin's collection builders, spelled like a setter (`setOf(a, b)`).
 */
const NOT_A_SETTER = new Set(["setOf", "setOfNotNull"]);

/** Arguments a call passes, a Kotlin trailing lambda included (`setOnClickListener { … }`). */
function valueCount(node: Node): number {
  const lambda = node.children.find((c) => c.type === "call_suffix")?.children.some((c) => c.type === "annotated_lambda") ? 1 : 0;
  return callArguments(node).length + lambda;
}

export class JavaKotlinMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["java", "kotlin"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    if (node.type === "method_invocation" || node.type === "call_expression") {
      // Kotlin `call_expression` has NO name/function field — the callee is a
      // navigation_expression/simple_identifier child. `resolveCall` handles
      // both grammars (same fix data-sources needed; the field-based path here
      // yielded zero Kotlin mutations).
      const fnName = resolveCall(node)?.method;

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

        // Setter methods (setXxx pattern): a property setter takes ONE value.
        // `stmt.setInt(1, id)` binds a JDBC parameter and `page.setFont(font, 12f)`
        // configures a drawing call — neither assigns a property.
        if (/^set[A-Z]/.test(fnName) && !NOT_A_SETTER.has(fnName) && valueCount(node) === 1) {
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
