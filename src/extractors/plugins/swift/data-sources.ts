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
const URLSESSION_RE = /\b(?:URLSession(?:\.shared)?|[a-z]\w*[sS]ession)\.(dataTask|data|download|upload|bytes)\s*\(/;
const URL_LITERAL_RE = /URL\s*\(\s*string:\s*"([^"]+)"/;
const ENV_RE = /Environment\.get\s*\(\s*"([^"]+)"/;

/** SwiftData: `@Query(sort: …) private var items: [Item]` reads the model it lists. */
const SWIFTDATA_QUERY_RE = /@Query\b(?:\([^)]*\))?\s*(?:private\s+|public\s+)?var\s+\w+\s*:\s*\[\s*([A-Z]\w*)\s*\]/;
/** `modelContext.insert(x)` / `.delete(x)` / `try context.fetch(FetchDescriptor<Item>(…))`. */
const SWIFTDATA_CONTEXT_RE = /\b(\w*[Cc]ontext)\.(insert|delete|fetch|fetchCount|save)\s*\(/;

/** Core Data reads: `NSFetchRequest<Item>`, `Item.fetchRequest()`, SwiftUI's `@FetchRequest … FetchedResults<Item>`. */
const COREDATA_READ_RE = /NSFetchRequest<\s*([A-Z]\w*)\s*>|\b([A-Z]\w*)\.fetchRequest\s*\(|FetchedResults<\s*([A-Z]\w*)\s*>/;
/** Core Data writes: a managed object made in a context (`Folder(context: ctx)`), or by entity name. */
const COREDATA_WRITE_RE = /\b([A-Z]\w*)\s*\(\s*context:|insertNewObject\s*\(\s*forEntityName:\s*"(\w+)"/;

/** Swift string interpolation `\(base)/x` as a `${base}` hole. */
const interpolated = (text: string): string => text.replace(/\\\(([^()]*)\)/g, "${$1}");

/**
 * The URL and verb a `URLSession` call sends: its argument is the request (`with: request`,
 * `for: request`) or the URL (`from: url`), written in place or a local above it —
 * `var request = URLRequest(url: url)`, `let url = URL(string: "https://…")!` — whose
 * `request.httpMethod = "POST"` names the verb (GET otherwise).
 */
function urlSessionRequest(lines: readonly string[], at: number): { target: string | null; verb: string } {
  const call = lines[at]!.slice(lines[at]!.search(URLSESSION_RE));
  let arg = /\b(?:with|for|from):\s*(.+?)(?:\)|,\s*\w+:|\s*\{|$)/.exec(call)?.[1]?.trim() ?? "";
  let verb = "GET";
  const literalOf = (text: string): string | null => {
    const m = /URL\s*\(\s*string:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
    return m ? interpolated(m[1]!) : null;
  };
  // Where the enclosing function begins: locals are read no further up.
  let from = at;
  while (from > 0 && at - from < 80 && !/^\s*(?:(?:public|private|internal|fileprivate|static|override|@\w+)\s+)*func\b/.test(lines[from]!)) from--;
  const local = (name: string): string | null => {
    for (let k = at - 1; k >= from; k--) {
      const m = new RegExp(String.raw`\b(?:let|var)\s+${name}\b[^=]*=\s*(.+)$`).exec(lines[k]!);
      if (m) return m[1]!.trim();
    }
    return null;
  };
  for (let hops = 0; hops < 4 && arg; hops++) {
    const lit = literalOf(arg);
    // A request: its verb is set on the local, its URL is the `url:` it is made from.
    const req = /URLRequest\s*\(\s*url:\s*(.+?)(?:,\s*\w+:|\)\s*$|\)$)/.exec(arg);
    if (req) { arg = req[1]!.trim(); continue; }
    if (lit !== null) return { target: lit, verb };
    if (!/^[A-Za-z_]\w*$/.test(arg)) break;
    for (let k = from; k < at; k++) {
      const set = new RegExp(String.raw`\b${arg}\.httpMethod\s*=\s*"(\w+)"`).exec(lines[k]!);
      if (set) verb = set[1]!.toUpperCase();
    }
    const init = local(arg);
    if (init === null) break;
    arg = init.replace(/!$/, "");
  }
  return { target: null, verb };
}

export function extractSwiftDataSources(lines: string[]): DataSourceInfo[] {
  const sources: DataSourceInfo[] = extractSqlStringDataSources(lines);
  const swiftData = lines.some((l) => /\bimport\s+SwiftData\b/.test(l));
  let hasURLSession = false;
  const coreData = lines.some((l) => /\bimport\s+CoreData\b|@FetchRequest\b/.test(l));

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

    if (coreData) {
      const read = COREDATA_READ_RE.exec(line);
      const model = read ? (read[1] ?? read[2] ?? read[3]) : undefined;
      if (model && model !== "NSManagedObject") {
        sources.push({ kind: "database", name: "Core Data: fetch", target: model, entity: model, calls: [], line: lineNo, access: "read" });
        continue;
      }
      const write = COREDATA_WRITE_RE.exec(line);
      const made = write ? (write[1] ?? write[2]) : undefined;
      if (made) {
        sources.push({ kind: "database", name: "Core Data: insert", target: made, entity: made, calls: [], line: lineNo, access: "write" });
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
    if (URLSESSION_RE.test(line) && (hasURLSession ||= lines.some((l) => /URLSession/.test(l)))) {
      const inline = line.match(URL_LITERAL_RE)?.[1] ?? null;
      const sent = urlSessionRequest(lines, i);
      sources.push({
        kind: "api-call",
        name: sent.target !== null || inline !== null ? sent.verb : "URLSession",
        target: inline ?? sent.target,
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
