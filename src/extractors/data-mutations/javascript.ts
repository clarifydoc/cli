import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../types/analysis.js";
import { DataMutationExtractor } from "./base.js";

/** React state setter patterns (setXxx) */
const SET_STATE_PATTERN = /^set[A-Z]/;

/** Known dispatch patterns */
const DISPATCH_NAMES = new Set(["dispatch", "emit", "send", "trigger"]);

export class JavaScriptMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["typescript", "javascript"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // setState / setXxx() calls
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const fnName = fn?.text;

      if (fnName) {
        if (SET_STATE_PATTERN.test(fnName) || fnName === "setState") {
          const args = node.childForFieldName("arguments");
          const value =
            args && args.childCount > 1
              ? this.truncate(args.child(1)?.text ?? null, 80)
              : null;
          mutations.push({
            kind: "setState",
            target: fnName,
            value,
            line: node.startPosition.row + 1,
          });
        }

        // dispatch(), emit(), etc.
        const baseName = fnName.split(".").pop()?.toLowerCase() ?? "";
        if (DISPATCH_NAMES.has(baseName)) {
          const args = node.childForFieldName("arguments");
          const value =
            args && args.childCount > 1
              ? this.truncate(args.child(1)?.text ?? null, 80)
              : null;
          mutations.push({
            kind: "dispatch",
            target: fnName,
            value,
            line: node.startPosition.row + 1,
          });
        }
      }
    }

    // .value = xxx (Vue ref mutations)
    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      if (left?.type === "member_expression") {
        const prop = left.childForFieldName("property");
        if (prop?.text === "value") {
          const right = node.childForFieldName("right");
          mutations.push({
            kind: "ref-mutation",
            target: left.text,
            value: this.truncate(right?.text ?? null, 80),
            line: node.startPosition.row + 1,
          });
        }
      }

      // this.state.xxx = or this.xxx =
      if (left?.text.startsWith("this.")) {
        const right = node.childForFieldName("right");
        mutations.push({
          kind: "assignment",
          target: left.text,
          value: this.truncate(right?.text ?? null, 80),
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
