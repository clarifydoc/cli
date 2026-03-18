import type { Language } from "../../types/analysis.js";

/**
 * Known HTTP/API client function & object names per language.
 * If a call name starts with or equals any of these, it's an API call.
 */
const API_ROOTS: Record<string, string[]> = {
  typescript: ["fetch", "axios", "http", "request", "ajax", "$http", "ky", "got", "superagent", "ofetch"],
  javascript: ["fetch", "axios", "http", "request", "ajax", "$http", "ky", "got", "superagent", "ofetch"],
  python: ["requests", "httpx", "aiohttp", "urllib", "http.client"],
  java: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit"],
  kotlin: ["RestTemplate", "WebClient", "HttpClient", "OkHttp", "Retrofit", "ktor"],
  csharp: ["HttpClient", "WebClient", "RestClient"],
  pascal: ["THTTPClient", "TRESTClient", "TIdHTTP"],
};

/** Method names that indicate an API/HTTP call */
const API_METHODS = new Set([
  "exchange", "getForObject", "getForEntity", "postForObject", "postForEntity",
  "execute", "send", "request",
]);

/**
 * Known database/ORM object & method patterns per language.
 * If a call name starts with or contains any of these, it's a database call.
 */
const DB_ROOTS: Record<string, string[]> = {
  typescript: [
    "prisma", "mongoose", "sequelize", "knex", "typeorm", "drizzle",
    "db", "pool", "connection", "pgClient", "redis",
  ],
  javascript: [
    "prisma", "mongoose", "sequelize", "knex", "typeorm", "drizzle",
    "db", "pool", "connection", "pgClient", "redis",
  ],
  python: [
    "cursor", "session", "engine", "db", "connection", "pool",
  ],
  java: [
    "JdbcTemplate", "entityManager", "session", "repository",
  ],
  kotlin: [
    "JdbcTemplate", "entityManager", "session", "repository",
  ],
  csharp: [
    "DbContext", "DbSet", "SqlCommand", "SqlConnection",
  ],
  pascal: [
    "Query", "Connection", "DataSet", "SQLQuery",
  ],
};

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
  const roots = API_ROOTS[language];
  if (!roots) return false;

  // Check if the root object is a known API client
  const rootObj = name.split(".")[0]!;
  if (roots.some(r => rootObj === r || rootObj.toLowerCase() === r.toLowerCase())) return true;

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
export function isDatabaseCall(name: string, language: Language): boolean {
  const roots = DB_ROOTS[language];
  if (!roots) return false;

  // Check if the root object is a known DB client/ORM
  const rootObj = name.split(".")[0]!;
  if (roots.some(r => rootObj === r || rootObj.toLowerCase() === r.toLowerCase())) {
    // Must also have a method call (not just "db" by itself)
    if (name.includes(".")) return true;
  }

  // Check if the method name matches DB patterns
  const method = name.includes(".") ? name.split(".").pop()! : name;
  if (DB_METHODS.has(method)) return true;

  // Java-style Spring Data patterns: findBy*, deleteBy*, countBy*, existsBy*
  if (method.startsWith("findBy") || method.startsWith("deleteBy") ||
      method.startsWith("countBy") || method.startsWith("existsBy")) return true;

  return false;
}
