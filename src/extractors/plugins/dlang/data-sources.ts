import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { dSqlLines } from "./source.js";

/**
 * HTTP calls a D program makes:
 *
 *  - vibe.d `requestHTTP("https://…", (scope req) { req.method = HTTPMethod.POST; … }, …)`
 *    (GET unless the request callback sets a method);
 *  - `std.net.curl` `get("https://…")`, `post(url, data)`, `put`, `del`,
 *    `patch` — absolute URLs only, so an associative array's `get(key, x)`
 *    is never read as one;
 *  - the `requests` package's `getContent(url)` / `postContent(url, …)`.
 *
 * Plus MongoDB collection access (`extractDMongoSources`). SQL in strings is
 * read from the raw source by `extractDSqlSources`.
 */
export function extractDDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, target: string, line: number) => {
    if (!target.startsWith("/") && !/^https?:\/\//i.test(target)) return;
    out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line });
  };
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/\brequestHTTP\s*\(\s*"([^"]+)"/g)) {
      const callback = lines.slice(i, i + 8).join("\n");
      push(/\.method\s*=\s*HTTPMethod\.(\w+)/.exec(callback)?.[1]?.toUpperCase() ?? "GET", m[1]!, i + 1);
    }
    for (const m of line.matchAll(/(?<![\w.])(get|post|put|patch|del|getContent|postContent)\s*(?:!\s*\w+\s*)?\(\s*"(https?:\/\/[^"]+)"/g)) {
      push(CURL_VERB[m[1]!]!, m[2]!, i + 1);
    }
  });
  return [...out, ...extractDMongoSources(lines)].sort((a, b) => a.line - b.line);
}

const CURL_VERB: Record<string, string> = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE", getContent: "GET", postContent: "POST",
};

const MONGO_READ = new Set(["find", "findOne", "count", "countDocuments", "estimatedDocumentCount", "aggregate", "distinct"]);
const MONGO_WRITE = new Set([
  "insert", "insertOne", "insertMany", "update", "updateOne", "updateMany", "replaceOne", "remove", "deleteOne",
  "deleteMany", "deleteAll", "findAndModify", "findAndModifyExt", "drop",
]);

/**
 * vibe.d MongoDB: calls on a collection — a `MongoCollection` field, local
 * or parameter, or a variable bound to `db["users"]` / `getCollection("app.users")`
 * — read (`find`, `findOne`, `count`, `aggregate`, …) or write (`insertOne`,
 * `updateOne`, `remove`, …) the collection, which is the entity: the name it
 * was bound to in this file, else the variable's (`m_users` → `users`).
 */
export function extractDMongoSources(lines: string[]): DataSourceInfo[] {
  if (!lines.some((l) => /\bMongoCollection\b|\bconnectMongoDB\b|\bvibe\.db\.mongo\b/.test(l))) return [];
  const collections = new Map<string, string | null>();
  for (const line of lines) {
    for (const m of line.matchAll(/\bMongoCollection\s+([A-Za-z_]\w*)/g)) if (!collections.has(m[1]!)) collections.set(m[1]!, null);
  }
  for (const line of lines) {
    const bind = /\b([A-Za-z_]\w*)\s*=\s*(.*?)(?:\[\s*"([^"]+)"\s*\]|\.getCollection\s*\(\s*"([^"]+)"\s*\))\s*;/.exec(line);
    if (!bind) continue;
    const receiver = bind[2]!.trim();
    const viaDb = bind[4] !== undefined || collections.has(bind[1]!) || /(?:^|[.\s])(?:\w*db|\w*database)\s*(?:\([^)]*\))?$/i.test(receiver);
    if (viaDb) collections.set(bind[1]!, bind[4] !== undefined ? bind[4].slice(bind[4].lastIndexOf(".") + 1) : bind[3]!);
  }
  const out: DataSourceInfo[] = [];
  lines.forEach((line, i) => {
    if (/^\s*\/\//.test(line)) return;
    for (const m of line.matchAll(/\b([A-Za-z_]\w*)\.(\w+)\s*(?:!\s*\w+\s*)?\(/g)) {
      if (!collections.has(m[1]!)) continue;
      const access = MONGO_READ.has(m[2]!) ? "read" : MONGO_WRITE.has(m[2]!) ? "write" : null;
      if (!access) continue;
      const entity = collections.get(m[1]!) ?? m[1]!.replace(/^m_/, "");
      out.push({ kind: "database", name: `${entity}.${m[2]}`, target: entity, entity, access, calls: [], line: i + 1 });
    }
  });
  return out;
}

/** SQL statements in the file's strings, every D string form included (raw source). */
export function extractDSqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(dSqlLines(rawLines));
}
