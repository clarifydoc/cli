import type { Node } from "web-tree-sitter";
import type { DataMutationInfo, Language } from "../../../types/analysis.js";
import { DataMutationExtractor } from "../../data-mutations/base.js";

export class PhpMutationExtractor extends DataMutationExtractor {
  readonly languages: Language[] = ["php"];

  protected visitNode(node: Node, mutations: DataMutationInfo[]): void {
    // `$this->prop = value` — surface as a state mutation.
    if (node.type === "assignment_expression") {
      const left = node.child(0);
      const right = node.child(2);
      const leftText = left?.text ?? "";
      if (leftText.startsWith("$this->")) {
        mutations.push({
          kind: "assignment",
          target: leftText,
          value: this.truncate(right?.text ?? null, 80),
          line: node.startPosition.row + 1,
        });
      }
    }

    // ORM writes: `$model->save()`, `$model->update(...)`, `$model->delete()`
    if (node.type === "member_call_expression") {
      const method = node.childForFieldName("name")?.text ?? "";
      if (/^(save|update|delete|destroy|insert|push|create)$/.test(method)) {
        const recv = node.childForFieldName("object")?.text ?? "";
        mutations.push({
          kind: "db-write",
          target: `${recv}->${method}`,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }

    // Static ORM writes: `Model::create(...)`, `DB::insert(...)`
    if (node.type === "scoped_call_expression") {
      const scope = node.childForFieldName("scope")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      if (/^(create|insert|update|delete|destroy|truncate)$/.test(name)) {
        mutations.push({
          kind: "db-write",
          target: `${scope}::${name}`,
          value: null,
          line: node.startPosition.row + 1,
        });
      }
    }
  }
}
