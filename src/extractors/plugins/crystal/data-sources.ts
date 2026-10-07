import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Crystal data access:
 *
 *  - ORMs: Avram's query and operation classes (`UserQuery.new.email(e)`
 *    reads `User`, `SaveUser.create(params)` writes it) here; a query on a
 *    model class (`Post.find(id)`, `post.save`) is joined project-wide,
 *    against the models the project declares (see `ormCalls`).
 *  - HTTP: `HTTP::Client.get("…")`, `HTTP::Client.exec("PUT", "…")`, a
 *    client bound to a base URL (`client = HTTP::Client.new(URI.parse("…"))`
 *    then `client.get("/x")`), Crest and Halite.
 *  - crystal-db: SQL in string literals and heredocs (`db.query("SELECT …")`,
 *    `<<-SQL … SQL`) — read from the RAW source by `extractCrystalSqlSources`,
 *    since the spec sees heredoc bodies blanked (see `blankHeredocs`).
 */
export function extractCrystalDataSources(lines: string[], _classes: ClassInfo[]): DataSourceInfo[] {
  return [...ormCalls(lines), ...httpCalls(lines)].sort((a, b) => a.line - b.line);
}

/** `#{order.id}` interpolation → `{id}` (the value's own name); a URL's own text otherwise. */
function urlOf(literal: string): string {
  return literal.replace(/#\{\s*([^}]*?)\s*\}/g, (_m, e: string) => `{${e.replace(/\(.*$|\s.*$/, "").split(".").pop()!.replace(/^@/, "")}}`);
}

/** The code of a line: `#` comments dropped, string contents kept. */
function codeOf(line: string): string {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") { i++; continue; }
    if (c === '"') inString = !inString;
    else if (c === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

/** Model methods that read. */
const READ = /^(?:find|find!|find_by|find_by!|find_each|find_in_batches|all|where|first|first!|last|last!|count|exists\?|order|limit|offset|select|pluck|includes|preload|any\?|empty\?|none\?)$/;
const WRITE = /^(?:create|create!|import|update|update!|update_all|delete|delete!|delete_all|destroy|destroy!|destroy_all|clear|upsert|upsert!)$/;
/** Instance methods that write the row a variable holds. */
const INSTANCE_WRITE = /^(?:save!?|update!?|update_columns|destroy!?|delete!?|touch|increment!?|decrement!?)$/;

/** Whether `Model.method` reads or writes, or is no query at all. */
export function modelAccess(method: string): "read" | "write" | null {
  return WRITE.test(method) ? "write" : READ.test(method) ? "read" : null;
}
/** Whether `record.method` writes the row the variable holds. */
export function isInstanceWrite(method: string): boolean {
  return INSTANCE_WRITE.test(method);
}

/** A model class declared in this file: `class Post < Granite::Base`, `< BaseModel`, `include Clear::Model`. */
const MODEL_DECL = /^\s*class\s+(?:[A-Z]\w*::)*([A-Z]\w*)\s*<\s*(?:Granite::Base|Jennifer::Model::Base|Avram::Model|BaseModel)\b/;

/**
 * ORM calls the FILE proves are queries. Avram's generated classes say so by
 * name (`UserQuery.new` reads User, `SaveUser.create` writes it); any other
 * `Post.find(id)` is a query only if `Post` is a model, which the file knows
 * only when it declares one — the rest are joined project-wide, against the
 * models the project declares (`CrystalEntityExtractor.reconcileProject`).
 * `Address.create` on a plain class is a factory, not a write.
 */
function ormCalls(lines: string[]): DataSourceInfo[] {
  const models = new Set<string>();
  for (const line of lines) {
    const m = MODEL_DECL.exec(line);
    if (m) models.add(m[1]!);
  }
  const out: DataSourceInfo[] = [];
  // Named as written (`UserQuery.new`); the entity is the model it queries.
  const push = (cls: string, entity: string, method: string, access: "read" | "write", line: number) =>
    out.push({ kind: "database", name: `${cls}.${method}`, target: entity, entity, access, calls: [], line });
  for (let i = 0; i < lines.length; i++) {
    const line = codeOf(lines[i]!);
    for (const m of line.matchAll(/(?<![\w.@:])(?:[A-Z]\w*::)*([A-Z]\w*)\.([a-z_]\w*[?!]?)/g)) {
      const [, cls, method] = m as unknown as [string, string, string];
      const query = /^([A-Z]\w*)Query$/.exec(cls);
      const operation = /^(?:Save|Delete)([A-Z]\w*)$/.exec(cls);
      if (query) { push(cls, query[1]!, method, "read", i + 1); continue; }
      if (operation && /^(?:create|update|delete|upsert|run)!?$/.test(method)) { push(cls, operation[1]!, method, "write", i + 1); continue; }
      const access = models.has(cls) ? modelAccess(method) : null;
      if (access) push(cls, cls, method, access, i + 1);
    }
  }
  return out;
}

const HTTP_VERBS = /^(?:get|post|put|patch|delete|head|options)$/;

function httpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, target: string, line: number) => {
    const url = urlOf(target);
    if (!url.startsWith("/") && !/^https?:\/\//i.test(url) && !url.startsWith("{")) return;
    out.push({ kind: "api-call", name: `${method} ${url}`, target: url, calls: [], line });
  };
  // `client = HTTP::Client.new(URI.parse("https://api.example.com"))` / `HTTP::Client.new("api.example.com")`.
  const clients = new Map<string, string>();
  for (const line of lines) {
    const m = /(?<![\w.])@?([a-z_]\w*)\s*=\s*(?:HTTP::Client|Halite::Client|Crest::Resource)\.new\s*\(?\s*(?:URI\.parse\s*\(\s*)?"([^"]*)"/.exec(line);
    if (m) clients.set(m[1]!, /^https?:\/\//.test(m[2]!) ? m[2]!.replace(/\/+$/, "") : `https://${m[2]}`);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = codeOf(lines[i]!);
    for (const m of line.matchAll(/\b(?:HTTP::Client|Crest|Halite)\.(\w+)\s*\(?\s*"([^"]+)"/g)) {
      if (HTTP_VERBS.test(m[1]!)) push(m[1]!.toUpperCase(), m[2]!, i + 1);
    }
    for (const m of line.matchAll(/\bHTTP::Client\.exec\s*\(?\s*"(\w+)"\s*,\s*"([^"]+)"/g)) push(m[1]!.toUpperCase(), m[2]!, i + 1);
    for (const m of line.matchAll(/\bCrest::Request\.execute\s*\(\s*:(\w+)\s*,\s*"([^"]+)"/g)) push(m[1]!.toUpperCase(), m[2]!, i + 1);
    for (const m of line.matchAll(/(?<![\w.])@?([a-z_]\w*)\.(\w+)\s*\(?\s*"(\/[^"]*)"/g)) {
      const base = clients.get(m[1]!);
      if (base && HTTP_VERBS.test(m[2]!)) push(m[2]!.toUpperCase(), base + m[3]!, i + 1);
    }
  }
  return out;
}

/**
 * The source with every heredoc's BODY blanked (`<<-SQL` … `SQL`), line
 * structure kept, so SQL or JSON in one is never read as code and never
 * breaks the indentation a block's end is found by. Null when there is none.
 */
export function blankHeredocs(source: string): string | null {
  if (!source.includes("<<-") && !source.includes("<<~")) return null;
  const lines = source.split("\n");
  let changed = false;
  for (const [start, end] of heredocSpans(lines)) {
    for (let i = start + 1; i < end; i++) lines[i] = "";
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

/** [opener index, terminator index] of each heredoc (0-based). */
function heredocSpans(lines: string[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /<<[-~]'?([A-Z_]\w*)'?/.exec(codeOf(lines[i]!));
    if (!m) continue;
    const term = new RegExp(String.raw`^\s*${m[1]}\b`);
    let j = i + 1;
    while (j < lines.length && !term.test(lines[j]!)) j++;
    if (j < lines.length) { spans.push([i, j]); i = j; }
  }
  return spans;
}

/**
 * SQL statements in the file's string literals and heredocs (raw source).
 * A heredoc's body is folded into one string on its opening line, where the
 * call that runs it is (`db.exec <<-SQL`).
 */
export function extractCrystalSqlSources(rawLines: string[]): DataSourceInfo[] {
  const lines = rawLines.map((l) => l.replace(/#\{[^}]*\}/g, "?"));
  for (const [start, end] of heredocSpans(rawLines)) {
    if (!isSqlHeredoc(rawLines, start, end)) continue;
    const body = rawLines.slice(start + 1, end).map((l) => l.trim()).join(" ").replace(/#\{[^}]*\}/g, "?").replace(/"/g, "'");
    lines[start] = `${lines[start]} "${body}"`;
    for (let i = start + 1; i <= end; i++) lines[i] = "";
  }
  return extractSqlStringDataSources(lines);
}

/**
 * A heredoc is read as SQL when its terminator says so (`SQL`, `QUERY`) or its
 * body opens with a statement — usage text and templates (`END_USAGE`) are
 * prose whose words (`update`) only look like SQL.
 */
function isSqlHeredoc(lines: string[], start: number, end: number): boolean {
  const term = lines[end]!.trim();
  if (/SQL|QUERY|STMT/i.test(term)) return true;
  const first = lines.slice(start + 1, end).find((l) => l.trim())?.trim() ?? "";
  return /^(?:SELECT|INSERT|UPDATE|DELETE|WITH|MERGE|CREATE|ALTER|DROP|REPLACE|UPSERT)\b/i.test(first);
}
