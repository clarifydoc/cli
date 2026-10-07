import type { ClassInfo, DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Groovy data access:
 *
 *  - GORM, Grails' ORM: static calls on a domain class (`Book.findAllByAuthor(a)`,
 *    `Book.get(id)`, `Book.where { … }`, `Book.executeQuery("…")`) and the
 *    instance writes (`book.save()`, `book.delete()`) when the file says what
 *    class the receiver holds (`def book = new Book(params)`, `Book book = …`).
 *    The entity is the domain class.
 *  - HTTP: RestTemplate, Micronaut `HttpRequest.GET`, `new URL("…")`.
 *  - Groovy SQL / JDBC: SQL in string literals (`sql.rows("SELECT …")`, a
 *    `'''…'''` block) — read from the RAW source by `extractGroovySqlSources`,
 *    since the spec sees multi-line strings blanked (see `preprocessGroovy`).
 */
export function extractGroovyDataSources(lines: string[], _classes: ClassInfo[]): DataSourceInfo[] {
  return [...gormCalls(lines), ...httpCalls(lines)].sort((a, b) => a.line - b.line);
}

/** SQL statements in the file's string literals (raw source). */
export function extractGroovySqlSources(rawLines: string[]): DataSourceInfo[] {
  return extractSqlStringDataSources(groovySqlLines(rawLines));
}

/**
 * The source with the INSIDE of every `'''…'''` / `"""…"""` block blanked —
 * line structure and delimiters kept — so a multi-line SQL or JSON string is
 * never read as code (`SUM(s.quantity)` is no call). Null when there is none.
 */
export function blankMultilineStrings(source: string): string | null {
  if (!source.includes("'''") && !source.includes('"""')) return null;
  let out = "";
  let i = 0;
  while (i < source.length) {
    const three = source.slice(i, i + 3);
    if (three !== "'''" && three !== '"""') {
      out += source[i]!;
      i++;
      continue;
    }
    const close = source.indexOf(three, i + 3);
    if (close < 0) return out + source.slice(i);
    out += three + source.slice(i + 3, close).replace(/[^\n\r]/g, " ") + three;
    i = close + 3;
  }
  return out;
}

// ─── GORM ─────────────────────────────────────────────────────────────────

/** GORM method names no other API shares: always a query on the receiver class. */
const GORM_READ = /^(?:find(?:All)?By\w+|countBy\w+|find(?:All)?Where|withCriteria|createCriteria|executeQuery|where|whereAny|getAll)$/;
const GORM_WRITE = /^(?:findOrCreateBy\w+|findOrSaveBy\w+|executeUpdate|saveAll|deleteAll)$/;
/**
 * GORM names the JDK shares (`Paths.get`, `Files.exists`, `Collections.list`):
 * a query only on a receiver that is not a well-known library class.
 */
const GORM_AMBIGUOUS_READ = /^(?:get|read|load|list|count|exists|first|last|findAll|find)$/;
const LIBRARY_CLASSES = new Set([
  "Paths", "Path", "Files", "File", "Collections", "Arrays", "Optional", "System", "Thread", "Math", "Integer", "Long",
  "Double", "Float", "Short", "Byte", "Boolean", "Character", "String", "Objects", "UUID", "Pattern", "Matcher",
  "LocalDate", "LocalDateTime", "LocalTime", "Instant", "Duration", "Period", "ZonedDateTime", "OffsetDateTime",
  "Executors", "CompletableFuture", "Stream", "IntStream", "LongStream", "Collectors", "Holders", "Environment",
  "Locale", "TimeZone", "Calendar", "Date", "URI", "URL", "Base64", "ThreadLocal", "Runtime", "Class", "Enum",
  "Map", "List", "Set", "Arrays", "BigDecimal", "BigInteger", "Charset", "StandardCharsets", "Logger", "LoggerFactory",
  "LogFactory", "JsonOutput", "JsonSlurper", "Eval", "GroovyShell", "Mock", "Stub", "Spy", "Mockito",
]);
const STATIC_CALL = /\b([A-Z]\w*)\.(\w+)\s*[({]/g;
const INSTANCE_WRITE = /\b([a-z_]\w*)\.(save|delete|merge|insert)\s*\(/g;

function gormCalls(lines: string[]): DataSourceInfo[] {
  // What class each variable of the file holds, from how it is bound.
  const holds = new Map<string, string>();
  for (const line of lines) {
    for (const m of line.matchAll(/\b(?:def|final|var)\s+([a-z_]\w*)\s*=\s*(?:new\s+([A-Z]\w*)\s*\(|([A-Z]\w*)\.(\w+)\s*[({])/g)) {
      const cls = m[2] ?? (m[4] && (GORM_READ.test(m[4]) || GORM_AMBIGUOUS_READ.test(m[4])) ? m[3] : undefined);
      if (cls && !LIBRARY_CLASSES.has(cls)) holds.set(m[1]!, cls);
    }
    for (const m of line.matchAll(/(?:^|[(,\s])([A-Z]\w*)\s+([a-z_]\w*)\s*(?:=|[,)]|$)/g)) {
      if (!LIBRARY_CLASSES.has(m[1]!)) holds.set(m[2]!, m[1]!);
    }
  }

  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = codeOf(lines[i]!);
    for (const m of line.matchAll(STATIC_CALL)) {
      const [, cls, method] = m as unknown as [string, string, string];
      const write = GORM_WRITE.test(method);
      const read = GORM_READ.test(method) || (GORM_AMBIGUOUS_READ.test(method) && !LIBRARY_CLASSES.has(cls));
      if (!write && !read) continue;
      out.push({ kind: "database", name: `${cls}.${method}`, target: cls, entity: cls, access: write ? "write" : "read", calls: [], line: i + 1 });
    }
    for (const m of line.matchAll(/\bnew\s+([A-Z]\w*)\s*\([^)]*\)\s*\.save\s*\(/g)) {
      out.push({ kind: "database", name: `${m[1]}.save`, target: m[1]!, entity: m[1]!, access: "write", calls: [], line: i + 1 });
    }
    for (const m of line.matchAll(INSTANCE_WRITE)) {
      const cls = holds.get(m[1]!);
      if (!cls) continue;
      out.push({ kind: "database", name: `${cls}.${m[2]}`, target: cls, entity: cls, access: "write", calls: [], line: i + 1 });
    }
  }
  return out;
}

/** A line with string contents and the trailing `//` comment blanked (columns kept). */
function codeOf(line: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") { out += "  "; i++; continue; }
      if (c === quote) { quote = ""; out += c; continue; }
      out += " ";
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return out + " ".repeat(line.length - i);
    if (c === '"' || c === "'") quote = c;
    out += c;
  }
  return out;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────

const REST_TEMPLATE: Record<string, string> = {
  getForObject: "GET", getForEntity: "GET", postForObject: "POST", postForEntity: "POST", postForLocation: "POST",
  put: "PUT", delete: "DELETE", patchForObject: "PATCH",
};

function httpCalls(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  const push = (method: string, target: string, line: number) => {
    if (!target.startsWith("/") && !/^https?:\/\//i.test(target)) return;
    out.push({ kind: "api-call", name: `${method} ${target}`, target, calls: [], line });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const m of line.matchAll(/\.(\w+)\s*\(\s*["']([^"']+)["']/g)) {
      const method = REST_TEMPLATE[m[1]!];
      if (method && /restTemplate|template|rest/i.test(line.slice(0, m.index))) push(method, m[2]!, i + 1);
    }
    for (const m of line.matchAll(/\.exchange\s*\(\s*["']([^"']+)["']\s*,\s*HttpMethod\.(\w+)/g)) push(m[2]!.toUpperCase(), m[1]!, i + 1);
    for (const m of line.matchAll(/\bHttpRequest\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*["']([^"']+)["']/g)) push(m[1]!, m[2]!, i + 1);
    for (const m of line.matchAll(/\bnew\s+URL\s*\(\s*["']([^"']+)["']\s*\)/g)) push("GET", m[1]!, i + 1);
    for (const m of line.matchAll(/["'](https?:\/\/[^"']+)["']\.toURL\s*\(\s*\)/g)) push("GET", m[1]!, i + 1);
  }
  return out;
}

// ─── SQL in strings ───────────────────────────────────────────────────────

/**
 * Groovy source in the C-like shape the shared SQL scanner reads: every
 * string — `'…'`, `"…"`, and each line of a `'''…'''` / `"""…"""` block —
 * written as one `"…"` literal, comments dropped, and a `;` closing each line
 * that ends a statement (Groovy's semicolons are optional). One output line
 * per input line, so line numbers stay true.
 */
function groovySqlLines(lines: string[]): string[] {
  const out: string[] = [];
  let triple: string | null = null;
  for (const line of lines) {
    let code = "";
    let text = "";
    const flushString = () => { code += `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; text = ""; };
    let i = 0;
    if (triple) {
      const close = line.indexOf(triple);
      if (close < 0) { text = line; flushString(); out.push(code); continue; }
      text = line.slice(0, close);
      flushString();
      i = close + 3;
      triple = null;
    }
    let single: string | null = null;
    for (; i < line.length; i++) {
      const c = line[i]!;
      if (single) {
        if (c === "\\") { text += line[i + 1] ?? ""; i++; continue; }
        if (c === single) { flushString(); single = null; continue; }
        text += c;
        continue;
      }
      if (c === "/" && line[i + 1] === "/") break;
      const three = line.slice(i, i + 3);
      if (three === "'''" || three === '"""') {
        const close = line.indexOf(three, i + 3);
        if (close < 0) { text = line.slice(i + 3); flushString(); triple = three; i = line.length; break; }
        text = line.slice(i + 3, close);
        flushString();
        i = close + 2;
        continue;
      }
      if (c === '"' || c === "'") { single = c; continue; }
      code += c;
    }
    if (single) flushString();
    if (!triple && !/(?:[,(+\[]|&&|\|\|)\s*$/.test(code)) code += ";";
    out.push(code);
  }
  return out;
}
