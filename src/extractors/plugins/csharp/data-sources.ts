import type { Node } from "web-tree-sitter";
import type { DataSourceInfo, Language } from "../../../types/analysis.js";
import { DataSourceExtractor } from "../../data-sources/base.js";

/**
 * C# data-source extractor — surfaces Entity Framework, Dapper, NHibernate,
 * raw ADO.NET, and HTTP client calls as DataSourceInfo entries.
 *
 * EF patterns recognised:
 *   - `_context.Users.Where(...)` / `db.Users.Find(id)` (DbSet<T> access)
 *   - `_context.SaveChanges()` / `SaveChangesAsync()`
 *   - `_context.Database.ExecuteSqlRaw(...)` / `FromSqlRaw(...)`
 *   - `dbSet.Add(entity)` / `dbSet.AddRange(entities)` / `Remove(entity)`
 *
 * Dapper: `connection.Query(...)` / `QueryAsync` / `Execute` / `ExecuteScalar`
 * NHibernate: `session.Query<T>()` / `session.Get<T>(id)` / `session.Save(entity)`
 * ADO.NET: `command.ExecuteReader()` / `ExecuteNonQuery()` / `ExecuteScalar()`
 */

const EF_READ_METHODS = new Set([
  "Find", "FindAsync",
  "First", "FirstOrDefault", "FirstAsync", "FirstOrDefaultAsync",
  "Single", "SingleOrDefault", "SingleAsync", "SingleOrDefaultAsync",
  "ToList", "ToListAsync", "ToArray", "ToArrayAsync",
  "Where", "Select", "Include", "ThenInclude", "OrderBy", "OrderByDescending",
  "GroupBy", "Join", "Count", "CountAsync", "Any", "AnyAsync",
  "FromSqlRaw", "FromSqlInterpolated", "FromSql",
]);

const EF_WRITE_METHODS = new Set([
  "Add", "AddAsync", "AddRange", "AddRangeAsync",
  "Update", "UpdateRange",
  "Remove", "RemoveRange",
  "Attach", "AttachRange",
  "SaveChanges", "SaveChangesAsync",
  "ExecuteSqlRaw", "ExecuteSqlInterpolated", "ExecuteSqlRawAsync", "ExecuteSqlInterpolatedAsync",
  "ExecuteUpdate", "ExecuteUpdateAsync", "ExecuteDelete", "ExecuteDeleteAsync",
]);

const DAPPER_METHODS = new Set([
  "Query", "QueryAsync", "QueryFirst", "QueryFirstAsync",
  "QueryFirstOrDefault", "QueryFirstOrDefaultAsync",
  "QuerySingle", "QuerySingleAsync", "QuerySingleOrDefault",
  "QueryMultiple", "QueryMultipleAsync",
  "Execute", "ExecuteAsync", "ExecuteScalar", "ExecuteScalarAsync",
  "ExecuteReader", "ExecuteReaderAsync",
]);

const ADO_METHODS = new Set([
  "ExecuteReader", "ExecuteReaderAsync",
  "ExecuteNonQuery", "ExecuteNonQueryAsync",
  "ExecuteScalar", "ExecuteScalarAsync",
  "Open", "OpenAsync", "Fill",
]);

const HTTP_CLIENT_METHODS = new Set([
  "GetAsync", "PostAsync", "PutAsync", "PatchAsync", "DeleteAsync",
  "SendAsync", "GetStringAsync", "GetByteArrayAsync", "GetStreamAsync",
  "GetFromJsonAsync", "PostAsJsonAsync", "PutAsJsonAsync",
]);

/** Detect EF DbContext "owner" patterns — names ending with Context/DbContext. */
const DBCONTEXT_SUFFIX = /Context$/;

export class CSharpDataSourceExtractor extends DataSourceExtractor {
  readonly languages: Language[] = ["csharp"];

  protected visitNode(node: Node, sources: DataSourceInfo[]): void {
    if (node.type !== "invocation_expression") return;

    const fn = node.childForFieldName("function");
    if (!fn) return;
    const fullName = this.fullCallName(fn);
    if (!fullName) return;

    const parts = fullName.split(".");
    const method = parts[parts.length - 1]!;
    const receiver = parts.length > 1 ? parts[parts.length - 2]! : "";
    const root = parts[0]!;

    // EF Core / EF 6 — DbContext.Set<T>(), context.Entities.Where(), SaveChanges()
    if (EF_READ_METHODS.has(method) || EF_WRITE_METHODS.has(method)) {
      const looksLikeEf =
        DBCONTEXT_SUFFIX.test(root) ||
        root === "_context" || root === "context" || root === "db" ||
        root === "_db" || root === "dbContext" || root === "_dbContext";
      if (looksLikeEf || method === "SaveChanges" || method === "SaveChangesAsync" ||
          method === "FromSqlRaw" || method === "FromSqlInterpolated" || method === "FromSql" ||
          method === "ExecuteSqlRaw" || method === "ExecuteSqlInterpolated") {
        sources.push(this.ds({
          kind: "database",
          name: `EF: ${method}`,
          target: receiver || null,
          line: node.startPosition.row + 1,
        }));
        return;
      }
    }

    // Dapper — IDbConnection.Query / Execute
    if (DAPPER_METHODS.has(method) &&
        (root === "connection" || root === "_connection" || root === "conn" ||
         /Connection$/.test(root))) {
      sources.push(this.ds({
        kind: "database",
        name: `Dapper: ${method}`,
        target: extractFirstStringArg(node),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Raw ADO.NET — SqlCommand / SqlConnection
    if (ADO_METHODS.has(method) &&
        (root === "cmd" || root === "command" || /Command$/.test(root) ||
         root === "connection" || /Connection$/.test(root) ||
         root === "adapter" || /Adapter$/.test(root))) {
      sources.push(this.ds({
        kind: "database",
        name: `ADO.NET: ${method}`,
        target: null,
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // NHibernate — session.Query<T>(), session.Get<T>(id)
    if ((method === "Query" || method === "Get" || method === "Load" ||
         method === "Save" || method === "Update" || method === "Delete" ||
         method === "SaveOrUpdate" || method === "Merge") &&
        (root === "session" || root === "_session" || /Session$/.test(root))) {
      sources.push(this.ds({
        kind: "database",
        name: `NHibernate: ${method}`,
        target: receiver || null,
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // HttpClient — GetAsync, PostAsync, etc.
    if (HTTP_CLIENT_METHODS.has(method)) {
      sources.push(this.ds({
        kind: "api-call",
        name: method,
        target: extractFirstStringArg(node),
        line: node.startPosition.row + 1,
      }));
      return;
    }

    // Configuration / environment access — IConfiguration["KEY"] / Environment.GetEnvironmentVariable
    if (method === "GetEnvironmentVariable" && root === "Environment") {
      sources.push(this.ds({
        kind: "env",
        name: "GetEnvironmentVariable",
        target: extractFirstStringArg(node),
        line: node.startPosition.row + 1,
      }));
    }
  }

  /** Build a dot-qualified call name from `function` field of an invocation. */
  private fullCallName(node: Node): string | null {
    if (node.type === "identifier") return node.text;
    if (node.type === "member_access_expression" || node.type === "member_expression") {
      const expr = node.childForFieldName("expression");
      const name = node.childForFieldName("name");
      const left = expr ? this.fullCallName(expr) : null;
      const right = name?.text ?? "";
      if (!right) return left;
      return left ? `${left}.${right}` : right;
    }
    if (node.type === "generic_name") {
      return node.childForFieldName("name")?.text ?? node.text.split("<")[0]!;
    }
    return node.text;
  }
}

/** Pull the first string-literal argument from an invocation_expression's arg list. */
function extractFirstStringArg(node: Node): string | null {
  const args = node.childForFieldName("arguments");
  if (!args) return null;
  for (const arg of args.children) {
    // arg is typically `argument` wrapping a string_literal
    const inner = arg.childCount > 0 ? arg.child(0) : null;
    const target = inner ?? arg;
    if (target.type === "string_literal" || target.type === "interpolated_string_expression" ||
        target.type === "verbatim_string_literal") {
      return target.text.replace(/^[@$]*["']|["']$/g, "");
    }
  }
  return null;
}
