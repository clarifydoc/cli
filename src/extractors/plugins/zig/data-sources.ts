import type { Node, Tree } from "web-tree-sitter";
import { DataSourceExtractor } from "../../data-sources/base.js";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { callArgs, calleeName, declValue, memberName, stringValue } from "./syntax.js";

/**
 * Zig data access:
 *  - SQL in any string or `\\` multiline string (pg.zig `conn.query("SELECT …", .{})`,
 *    zqlite / sqlite `db.exec(…)`) — one source per statement;
 *  - `std.http.Client`: `client.fetch(.{ .location = .{ .url = "…" }, .method = .POST })`,
 *    and `client.open(.GET, uri, …)` / `client.request(.GET, uri, …)` with the
 *    URI parsed from a literal (`try std.Uri.parse("…")`, inline or bound in the file).
 */
export class ZigDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["zig"];
  /** Per file: `const uri = try std.Uri.parse("…")` bindings. */
  private uris = new Map<string, string>();

  override beginFile(tree: Tree): void {
    this.uris = parsedUris(tree.rootNode);
  }

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type === "string" || node.type === "multiline_string") {
      const value = stringValue(node);
      if (value && /\b(?:SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.test(value)) {
        const literal = `"${value.replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
        for (const s of extractSqlStringDataSources([literal])) sources.push({ ...s, line: node.startPosition.row + 1 });
      }
      return;
    }
    if (node.type !== "call_expression") return;
    const member = memberName(node.childForFieldName("function"));
    const args = callArgs(node);
    let method: string | null = null;
    let url: string | null = null;
    if (member === "fetch" && args[0]?.type === "anonymous_struct_initializer") {
      const fields = initFields(args[0]);
      const location = fields.get("location");
      url = location?.type === "anonymous_struct_initializer" ? stringValue(initFields(location).get("url")) : uriOf(location, this.uris);
      method = enumLiteral(fields.get("method")) ?? "GET";
    } else if (member === "open" || member === "request") {
      method = enumLiteral(args[0]);
      url = uriOf(args[1], this.uris);
    }
    if (method && url && (url.startsWith("/") || /^https?:\/\//.test(url))) {
      sources.push(this.ds({ kind: "api-call", name: `${method} ${url}`, target: url, line: node.startPosition.row + 1 }));
    }
  }
}

/** `.POST` → `POST`. */
function enumLiteral(node: Node | undefined): string | null {
  if (node?.type !== "field_expression" || node.childForFieldName("object")) return null;
  const m = node.childForFieldName("member")?.text;
  return m && /^[A-Z]+$/.test(m) ? m : null;
}

/** A literal URL: `"https://…"`, `try std.Uri.parse("…")`, or a local bound to one. */
function uriOf(node: Node | undefined, uris: Map<string, string>): string | null {
  if (!node) return null;
  if (node.type === "try_expression") return uriOf(node.namedChildren[0], uris);
  if (node.type === "identifier") return uris.get(node.text) ?? null;
  if (node.type === "call_expression" && calleeName(node.childForFieldName("function"))?.endsWith("Uri.parse")) return stringValue(callArgs(node)[0]);
  return stringValue(node);
}

function parsedUris(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const decl of root.descendantsOfType("variable_declaration")) {
    const name = decl.namedChildren[0]?.type === "identifier" ? decl.namedChildren[0].text : null;
    const url = uriOf(declValue(decl) ?? undefined, new Map());
    if (name && url && /^(?:https?:\/\/|\/)/.test(url)) out.set(name, url);
  }
  return out;
}

/** `.name = value` entries of an anonymous struct initializer. */
function initFields(init: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  const list = init.namedChildren.find((c) => c.type === "initializer_list");
  for (const assign of list?.namedChildren ?? []) {
    if (assign.type !== "assignment_expression") continue;
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    const name = left?.type === "field_expression" ? left.childForFieldName("member")?.text : null;
    if (name && right) out.set(name, right);
  }
  return out;
}
