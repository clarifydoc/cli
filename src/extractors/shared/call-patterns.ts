import type { Language } from "../../types/analysis.js";

/**
 * Call-classification patterns. The per-language root lists (API clients,
 * DB/ORM objects) live in each plugin's meta (`apiCallRoots` / `dbCallRoots`)
 * and are pushed in here by `extractors/registry.ts` at load time; the
 * method-name sets below are cross-language. This module stays a leaf — it
 * is imported from plugin code (e.g. javascript/data-sources), so it must
 * not import the registry or any plugin itself.
 */

const API_ROOTS = new Map<Language, readonly string[]>();
const DB_ROOTS = new Map<Language, readonly string[]>();

/** Called by the registry while aggregating plugin metas. */
export function registerCallPatterns(
  language: Language,
  apiRoots: readonly string[] | undefined,
  dbRoots: readonly string[] | undefined,
): void {
  if (apiRoots) API_ROOTS.set(language, apiRoots);
  if (dbRoots) DB_ROOTS.set(language, dbRoots);
}

/**
 * Method names that indicate an API/HTTP call on any receiver. Not `execute`:
 * on an unknown receiver it is a statement far more often than a request —
 * DB-API `cursor.execute(sql)`, JDBC `stmt.execute(sql)`, a command object's
 * `Execute()` — and an HTTP client spelled that way is named by its root.
 */
const API_METHODS = new Set([
  "exchange", "getForObject", "getForEntity", "postForObject", "postForEntity",
  "send", "request",
]);

/**
 * Does `name`'s receiver root match one of `roots`? A dotted root
 * (`http.client`, `urllib.request`, `clj-http.client`) names a module path and
 * matches as a prefix of the call, so `urllib.parse.quote` is not `urllib.request`.
 */
function matchesRoot(name: string, roots: readonly string[]): boolean {
  const rootObj = name.split(".")[0]!.toLowerCase();
  const lower = name.toLowerCase();
  return roots.some((r) => {
    const root = r.toLowerCase();
    return root.includes(".") ? lower === root || lower.startsWith(root + ".") : rootObj === root;
  });
}

/** Method names that indicate database operations */
const DB_METHODS = new Set([
  // Read
  "find", "findOne", "findMany", "findFirst", "findUnique", "findAll", "findById",
  "findBy", "findOrFail", "findOrCreate",
  "get", "getOne", "getMany", "getAll",
  "query", "rawQuery", "raw",
  "select", "where", "from",
  "aggregate", "count", "sum", "avg",
  // Write
  "create", "createMany", "insert", "insertMany",
  "update", "updateMany", "updateOne", "upsert",
  "delete", "deleteMany", "deleteOne", "remove", "destroy",
  "save", "saveAll", "persist", "merge", "flush",
  // Execute
  "execute", "executeQuery", "executeUpdate", "exec",
  "transaction", "beginTransaction", "commit", "rollback",
  // ORM specific
  "populate", "lean", "sort", "limit", "skip", "paginate",
  "FromSqlRaw", "FromSql",
]);

/**
 * Check if a call name matches an API/HTTP pattern for the given language.
 */
export function isApiCall(name: string, language: Language): boolean {
  const roots = API_ROOTS.get(language);
  if (!roots) return false;

  // Check if the root object is a known API client
  if (matchesRoot(name, roots)) return true;

  // Check if the method is a known API method on a qualified call
  if (name.includes(".")) {
    const method = name.split(".").pop()!;
    if (API_METHODS.has(method)) return true;
  }

  return false;
}

/**
 * Check if a call name matches a database/ORM pattern for the given language.
 */
/**
 * `byMethodName: false` keeps only the strong evidence — a known DB client or
 * ORM root — and drops the method-name fallback (`get`, `update`, `count`…),
 * which on its own also matches every dictionary, Map and project method of
 * the same name.
 */
export function isDatabaseCall(name: string, language: Language, byMethodName = true): boolean {
  const roots = DB_ROOTS.get(language);
  if (!roots) return false;

  // Check if the root object is a known DB client/ORM
  // (must also have a method call — not just "db" by itself)
  if (name.includes(".") && matchesRoot(name, roots)) return true;

  // A bare call (`sum(xs)`, `count(…)`) is a function, not a method on a
  // datastore: its name alone is no evidence.
  if (!byMethodName || !name.includes(".")) return false;

  // Check if the method name matches DB patterns
  const method = name.split(".").pop()!;
  if (DB_METHODS.has(method)) return true;

  // Java-style Spring Data patterns: findBy*, deleteBy*, countBy*, existsBy*
  if (method.startsWith("findBy") || method.startsWith("deleteBy") ||
      method.startsWith("countBy") || method.startsWith("existsBy")) return true;

  return false;
}
