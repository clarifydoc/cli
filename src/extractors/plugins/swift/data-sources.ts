import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Swift data sources — Fluent (Vapor's ORM), raw SQL strings, URLSession /
 * Alamofire / Vapor-client HTTP calls, and Environment reads. Swift had no
 * data-source extraction at all.
 */

/** `User.query(on: req.db)` / `User.find(id, on: req.db)` — entity = the model
 *  type. Lazy `.*?` (not `[^)]*`) because arguments routinely nest calls:
 *  `User.find(req.parameters.get("id"), on: req.db)`. */
const FLUENT_STATIC_RE = /\b([A-Z]\w*)\.(query|find)\s*\(.*?\bon:/;
/** `todo.save(on: db)` / `.create(on:)` / `.delete(on:)` — instance persistence. */
const FLUENT_INSTANCE_RE = /\b(\w+)\.(save|create|update|delete|restore)\s*\(\s*on:\s*[\w.]+/;
/** Alamofire / Vapor client / URLSession convenience verbs with a literal URL. */
const HTTP_CLIENT_RE = /\b(?:AF|\w*[Cc]lient)\.(request|get|post|put|patch|delete)\s*\(\s*"([^"]+)"/;
const URLSESSION_RE = /URLSession(?:\.shared)?\.(dataTask|data|download|upload)\s*\(/;
const URL_LITERAL_RE = /URL\s*\(\s*string:\s*"([^"]+)"/;
const ENV_RE = /Environment\.get\s*\(\s*"([^"]+)"/;

/** SwiftData: `@Query(sort: …) private var items: [Item]` reads the model it lists. */
const SWIFTDATA_QUERY_RE = /@Query\b(?:\([^)]*\))?\s*(?:private\s+|public\s+)?var\s+\w+\s*:\s*\[\s*([A-Z]\w*)\s*\]/;
/** `modelContext.insert(x)` / `.delete(x)` / `try context.fetch(FetchDescriptor<Item>(…))`. */
const SWIFTDATA_CONTEXT_RE = /\b(\w*[Cc]ontext)\.(insert|delete|fetch|fetchCount|save)\s*\(/;

export function extractSwiftDataSources(lines: string[]): DataSourceInfo[] {
  const sources: DataSourceInfo[] = extractSqlStringDataSources(lines);
  const swiftData = lines.some((l) => /\bimport\s+SwiftData\b/.test(l));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;

    if (swiftData) {
      const q = SWIFTDATA_QUERY_RE.exec(line);
      if (q) {
        sources.push({ kind: "database", name: "SwiftData: @Query", target: q[1]!, entity: q[1]!, calls: [], line: lineNo, access: "read" });
        continue;
      }
      const c = SWIFTDATA_CONTEXT_RE.exec(line);
      if (c && c[2] !== "save") {
        // `FetchDescriptor<Item>(…)`, or a model built in place: `insert(Item(name: n))`.
        const model = /FetchDescriptor<\s*([A-Z]\w*)\s*>/.exec(line)?.[1] ?? /\.(?:insert|delete)\s*\(\s*([A-Z]\w*)\s*\(/.exec(line)?.[1];
        const write = c[2] === "insert" || c[2] === "delete";
        sources.push({ kind: "database", name: `SwiftData: ${c[1]}.${c[2]}`, target: model ?? null, ...(model ? { entity: model } : {}), calls: [], line: lineNo, access: write ? "write" : "read" });
        continue;
      }
    }

    const fluent = line.match(FLUENT_STATIC_RE);
    if (fluent) {
      sources.push({
        kind: "database",
        name: `Fluent: ${fluent[2]}`,
        target: fluent[1]!,
        entity: fluent[1]!,
        calls: [],
        line: lineNo,
      });
      continue;
    }
    const inst = line.match(FLUENT_INSTANCE_RE);
    if (inst) {
      sources.push({
        kind: "database",
        name: `Fluent: ${inst[2]}`,
        target: inst[1]!,
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const http = line.match(HTTP_CLIENT_RE);
    if (http) {
      // `AF.request(url, method: .post)` names its method; without one Alamofire sends GET.
      const stated = http[1] === "request" ? /\bmethod:\s*(?:HTTPMethod)?\.(\w+)|\bmethod:\s*HTTPMethod\(\s*rawValue:\s*"(\w+)"/.exec(line.slice(http.index! + http[0].length)) : null;
      const verb = http[1] === "request" ? (stated?.[1] ?? stated?.[2] ?? "get").toUpperCase() : http[1]!.toUpperCase();
      sources.push({ kind: "api-call", name: verb, target: http[2]!, calls: [], line: lineNo });
      continue;
    }
    if (URLSESSION_RE.test(line)) {
      sources.push({
        kind: "api-call",
        name: "URLSession",
        target: line.match(URL_LITERAL_RE)?.[1] ?? null,
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const env = line.match(ENV_RE);
    if (env) {
      sources.push({ kind: "env", name: "Environment.get", target: env[1]!, calls: [], line: lineNo });
    }
  }

  return sources;
}
