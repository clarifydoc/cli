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
const DB_ROOT_TYPES = new Map<Language, Readonly<Record<string, RegExp>>>();

/** Called by the registry while aggregating plugin metas. */
export function registerCallPatterns(
  language: Language,
  apiRoots: readonly string[] | undefined,
  dbRoots: readonly string[] | undefined,
  dbRootTypes?: Readonly<Record<string, RegExp>>,
): void {
  if (apiRoots) API_ROOTS.set(language, apiRoots);
  if (dbRoots) DB_ROOTS.set(language, dbRoots);
  if (dbRootTypes) DB_ROOT_TYPES.set(language, dbRootTypes);
}

/** Whether the language constrains some DB roots by declared type (`dbRootTypes`). */
export function hasDbRootTypes(language: Language): boolean {
  return DB_ROOT_TYPES.has(language);
}

/**
 * A receiver named like a DB root whose declared type says it is something
 * else (`KeycloakSession session` where only Hibernate's `Session` is one):
 * neither its root nor its method names are database evidence.
 */
export function dbRootRefused(root: string, declaredType: string, language: Language): boolean {
  const types = DB_ROOT_TYPES.get(language);
  // Own keys only: a receiver named `constructor` or `toString` is no DB root, not Object's member.
  const re = types && Object.hasOwn(types, root.toLowerCase()) ? types[root.toLowerCase()] : undefined;
  if (!re) return false;
  const simple = declaredType.replace(/<.*$/s, "").replace(/\?$/, "").split(/[.\\$]/).pop()!.trim();
  return !re.test(simple);
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
 * Method names every collection, dictionary and helper object has too
 * (`clubs.get(id)`, `scores.count()`, `queue.remove(x)`): on their own they
 * are no database evidence. They count only on a receiver that names a data
 * handle or a model.
 */
const GENERIC_DB_METHODS = new Set([
  "get", "getOne", "getMany", "getAll", "find", "count", "sum", "avg", "sort", "limit", "skip",
  "merge", "flush", "remove", "raw", "from", "select", "where", "populate", "lean", "paginate", "aggregate",
]);

/**
 * A receiver that names a data handle: a repository, DAO, session, cursor,
 * connection, query or model manager (`playerRepo`, `db`, `Club.objects`,
 * `session`, `qs`, `trx`).
 */
const DATA_HANDLE_RECEIVER = /(?:repo|repos|repository|repositories|dao|db|database|model|models|table|objects|query|queryset|qs|session|em|entitymanager|manager|cursor|conn|connection|knex|prisma|orm|tx|trx|transaction|datasource|store)$/i;

/** A receiver named for an in-memory collection, cache or bag of values. */
const IN_MEMORY_RECEIVER = /(?:cache|caches|map|maps|claims|headers|params|props|properties|attributes|options|settings|dict|lookup|registry|collections|set|list|array)$/i;

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

  // A receiver named as an in-memory collection (`bundleCache.get`, `claims.get`,
  // `includedCollections.get`) holds no data store: its method name is no evidence.
  const parts = name.split(".");
  if (parts.length >= 2 && IN_MEMORY_RECEIVER.test(parts[parts.length - 2]!)) return false;

  // Check if the method name matches DB patterns
  const method = parts[parts.length - 1]!;
  if (GENERIC_DB_METHODS.has(method)) {
    // A model class (`Club.find(…)`) or a data handle (`clubRepo.get(…)`, `Club.objects.get(…)`);
    // an untyped `clubs.get(id)` is a dictionary as often as not.
    const receiver = parts[parts.length - 2]!.replace(/\(.*$/s, "");
    return /^[A-Z][A-Za-z0-9_]*$/.test(receiver) || DATA_HANDLE_RECEIVER.test(receiver);
  }
  if (DB_METHODS.has(method)) return true;

  // Java-style Spring Data patterns: findBy*, deleteBy*, countBy*, existsBy*
  if (method.startsWith("findBy") || method.startsWith("deleteBy") ||
      method.startsWith("countBy") || method.startsWith("existsBy")) return true;

  return false;
}
