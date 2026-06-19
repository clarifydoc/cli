import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

/** A CodeIgniter Query Builder receiver — `$this->db`, including fluent chains. */
const CI_DB_RECEIVER = /\$this\s*->\s*db\b/;

/**
 * CodeIgniter Query Builder verbs whose first string argument names a table.
 * (Refinement verbs — where/select/order_by/group_by/like/limit/… — carry only
 * columns, so they're deliberately excluded.)
 */
const CI_TABLE_VERBS: ReadonlySet<string> = new Set<string>([
  "get", "get_where", "from", "join",
  "insert", "insert_batch", "insert_string", "replace",
  "update", "update_batch", "update_string", "delete",
  "count_all", "count_all_results", "truncate", "empty_table",
]);

/**
 * PHP data sources — HTTP clients, database calls, environment lookups.
 *
 * Coverage:
 *   - HTTP: Guzzle `$client->get(...)`, Symfony/Laravel `Http::get(...)`, curl
 *   - DB:   PDO `$pdo->query(...)`, Eloquent `Model::where(...)`, Laravel `DB::table(...)`
 *   - Env:  `getenv(...)`, `$_ENV[...]`, `env(...)` (Laravel)
 */
export class PhpDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["php"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    // function_call_expression (env, curl_*, getenv, file_get_contents)
    if (node.type === "function_call_expression") {
      const fnNode = node.childForFieldName("function");
      const fnName = fnNode?.text;
      if (!fnName) return;

      const line = node.startPosition.row + 1;

      if (fnName === "getenv" || fnName === "env") {
        sources.push(this.ds({
          kind: "env",
          name: fnName,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }

      if (fnName.startsWith("curl_") || fnName === "file_get_contents") {
        sources.push(this.ds({
          kind: "api-call",
          name: fnName,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }
    }

    // member_call_expression — Guzzle, PDO, Eloquent instance calls
    if (node.type === "member_call_expression") {
      const nameNode = node.childForFieldName("name");
      const objNode = node.childForFieldName("object");
      const method = nameNode?.text ?? "";
      const recvText = objNode?.text ?? "";
      const line = node.startPosition.row + 1;
      const callText = `${recvText}->${method}`;

      // CodeIgniter Query Builder: `$this->db->get('orders')`,
      // `$this->db->from('orders')`, `$this->db->insert('orders', $d)`, …
      // The table is the first string arg of a *table-carrying* verb; query
      // refinement verbs (where/select/order_by/…) carry only column names, so
      // they are not data sources in their own right. The `$this->db` receiver
      // also matches a fluent chain — `$this->db->select(...)->from('orders')`
      // — because the chain's receiver text still contains `$this->db`. Setting
      // `entity` is what lets `attributeDataAccessToSymbols` keep the access
      // (an entity-less `database` source is dropped), so the model method that
      // runs the query reaches the table in the Call Traces view.
      if (CI_DB_RECEIVER.test(recvText)) {
        if (CI_TABLE_VERBS.has(method)) {
          const table = this.cleanTable(this.firstStringArg(node));
          if (table) {
            sources.push(this.ds({
              kind: "database",
              name: callText,
              target: table,
              entity: table,
              line,
            }));
          }
        }
        return; // every $this->db->… call is owned by this branch
      }

      // Guzzle-style HTTP: $client->get/post/put/patch/delete/request
      if (/Http|Client|Guzzle/i.test(recvText) && /^(get|post|put|patch|delete|request)$/i.test(method)) {
        sources.push(this.ds({
          kind: "api-call",
          name: callText,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }

      // PDO + Eloquent + generic ORM patterns
      if (/^(query|exec|prepare|fetchAll|fetch|find|first|get|all|where|select|insert|update|delete|save|create)$/.test(method)) {
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }
    }

    // scoped_call_expression — Laravel facades and Eloquent static calls
    if (node.type === "scoped_call_expression") {
      const scope = node.childForFieldName("scope")?.text ?? "";
      const name = node.childForFieldName("name")?.text ?? "";
      const line = node.startPosition.row + 1;
      const callText = `${scope}::${name}`;

      if (scope === "Http" && /^(get|post|put|patch|delete|head|options|send|request)$/i.test(name)) {
        sources.push(this.ds({
          kind: "api-call",
          name: callText,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }

      if (scope === "DB" || scope === "Schema" || scope === "Cache" || scope === "Redis") {
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: this.firstStringArg(node) ?? null,
          line,
        }));
        return;
      }

      // Eloquent: Model::find / Model::where / Model::create etc. Heuristic —
      // PascalCase scope and a known persistence method.
      if (/^[A-Z]/.test(scope) && /^(find|where|create|update|destroy|delete|all|first|firstOrCreate|firstOrFail|paginate|with|join|select)$/.test(name)) {
        sources.push(this.ds({
          kind: "database",
          name: callText,
          target: scope,
          line,
        }));
      }
    }

    // $_ENV['KEY'] / $_SERVER['KEY']
    if (node.type === "subscript_expression") {
      const obj = node.child(0);
      if (obj && obj.type === "variable_name") {
        const varText = obj.text;
        if (varText === "$_ENV" || varText === "$_SERVER" || varText === "$_GET" || varText === "$_POST") {
          sources.push(this.ds({
            kind: "env",
            name: varText,
            target: this.firstStringChild(node),
            line: node.startPosition.row + 1,
          }));
        }
      }
    }
  }

  /** Pull the first string argument from a call's `arguments` field. */
  private firstStringArg(node: Node): string | null {
    const args = node.childForFieldName("arguments");
    if (!args) return null;
    for (const a of args.children) {
      if (a.type === "argument") {
        for (const inner of a.children) {
          if (inner.type === "string") return inner.text.replace(/^['"]|['"]$/g, "");
          if (inner.type === "encapsed_string") return inner.text.replace(/^"|"$/g, "");
        }
      }
    }
    return null;
  }

  private firstStringChild(node: Node): string | null {
    for (const c of node.children) {
      if (c.type === "string") return c.text.replace(/^['"]|['"]$/g, "");
    }
    return null;
  }

  /**
   * Normalize a CodeIgniter table argument to a bare table name:
   *   `'orders o'` (alias) → `orders`, `'db.orders'` (schema) → `orders`,
   *   `` `orders` `` (quoted identifier) → `orders`. Returns null for anything
   *   that isn't a plain identifier (a sub-select, an expression, a variable).
   */
  private cleanTable(raw: string | null): string | null {
    if (!raw) return null;
    let t = raw.trim();
    t = t.split(/\s+/)[0] ?? ""; // drop a table alias: "orders o"
    t = t.split(".").pop() ?? t; // drop schema/db prefix: "db.orders"
    t = t.replace(/`/g, ""); // strip backtick identifier quoting
    return /^[A-Za-z_]\w*$/.test(t) ? t : null;
  }
}
