import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

export class PythonDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["python"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "call") {
      const fn = node.childForFieldName("function");
      const fnName = fn?.text;

      if (fnName) {
        // pika (RabbitMQ): channel.basic_publish(exchange=, routing_key=, body=)
        // / channel.basic_consume(queue=, on_message_callback=). The method
        // names are AMQP-specific, so any receiver is trusted.
        const leaf = fnName.split(".").pop()!;
        if (leaf === "basic_publish") {
          const routingKey = pyArg(node, "routing_key", 1);
          sources.push(this.ds({
            kind: "queue-publish",
            name: "RabbitMQ: basic_publish",
            target: pyArg(node, "exchange", 0),
            ...(routingKey ? { entity: routingKey } : {}),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        if (leaf === "basic_consume") {
          sources.push(this.ds({
            kind: "queue-consume",
            name: "RabbitMQ: basic_consume",
            target: pyArg(node, "queue", 0),
            line: node.startPosition.row + 1,
          }));
          return;
        }
        // requests.get(), httpx.get(), etc.
        if (
          fnName.includes("requests.") ||
          fnName.includes("httpx.") ||
          fnName.includes("aiohttp.")
        ) {
          const args = node.childForFieldName("arguments");
          let target: string | null = null;
          if (args && args.childCount > 1) {
            const firstArg = args.child(1);
            if (firstArg) target = firstArg.text.replace(/^['"]|['"]$/g, "");
          }
          sources.push(this.ds({
            kind: "api-call",
            name: fnName,
            target,
            line: node.startPosition.row + 1,
          }));
        }

        // os.environ, os.getenv
        if (fnName.includes("os.getenv") || fnName.includes("os.environ")) {
          sources.push(this.ds({
            kind: "env",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }

        // Database patterns — matched on the exact method LEAF, not substring:
        // `RE_CPP_CLASSNAME.findall(...)` (the re module) contains ".find" but
        // is not a DB op, and it was minting phantom regex-constant "entities".
        if (fnName.includes(".") && PY_DB_LEAVES.has(leaf)) {
          sources.push(this.ds({
            kind: "database",
            name: fnName,
            target: null,
            line: node.startPosition.row + 1,
          }));
        }
      }
    }
  }
}

/** Method leaves that indicate a DB op (SQLAlchemy / Django ORM / pymongo / DB-API). */
const PY_DB_LEAVES = new Set([
  "query", "execute", "executemany", "find", "find_one", "find_many",
  "filter", "filter_by", "all", "first", "get_or_create", "save",
  "insert_one", "insert_many", "update_one", "update_many",
  "delete_one", "delete_many", "count_documents", "aggregate",
]);

/**
 * Resolve a call argument by keyword (`queue="tasks"`) or position, returning
 * a string literal's unquoted value or any other expression's source text
 * (`config.EXCHANGE` — still a usable join label). Empty-string literals
 * (pika's default exchange) return null.
 */
function pyArg(call: Node, keyword: string, index: number): string | null {
  const args = call.childForFieldName("arguments");
  if (!args) return null;
  let value: Node | null = null;
  let positional = 0;
  for (const a of args.namedChildren) {
    if (a.type === "keyword_argument") {
      if (a.childForFieldName("name")?.text === keyword) {
        value = a.childForFieldName("value");
        break;
      }
    } else if (a.type !== "comment") {
      if (positional === index && value === null) value = a;
      positional++;
    }
  }
  if (!value) return null;
  const text = value.type === "string"
    ? value.text.replace(/^[rbfu]*['"]{1,3}|['"]{1,3}$/gi, "")
    : value.text.replace(/\s+/g, " ");
  return text && text.length <= 64 ? text : null;
}
