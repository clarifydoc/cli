import type { DataSourceInfo, FunctionInfo } from "../../../types/analysis.js";
import { tableFrom } from "../shared/sql-string-sources.js";
import { sqlVerbAccess } from "../shared/db-access.js";

/**
 * MyBatis mapper XML: the SQL of a Java mapper interface, statement by
 * statement.
 *
 *     <mapper namespace="com.acme.mapper.UserMapper">
 *       <sql id="cols">id, name</sql>
 *       <select id="findById" resultMap="userMap">
 *         SELECT <include refid="cols"/> FROM users u LEFT JOIN depts d ON …
 *         <where><if test="id != null">u.id = #{id}</if></where>
 *       </select>
 *
 * Each `<select|insert|update|delete id>` becomes a function named by its id,
 * decorated with the verb and the namespace (`@select(namespace =
 * "com.acme.mapper.UserMapper")`) — the method of the interface MyBatis
 * binds it to, which `MyBatisMapperResolver` links. Its SQL, with `<include>`
 * fragments spliced in and the dynamic-SQL tags, CDATA markers and
 * `#{…}`/`${…}` parameters taken out, names the table it reads or writes;
 * a select's JOINs are reads too.
 */

export interface MapperStatement {
  id: string;
  verb: "select" | "insert" | "update" | "delete";
  line: number;
  endLine: number;
  sql: string;
}

export interface ParsedMapper {
  namespace: string;
  statements: MapperStatement[];
}

const STATEMENT_RE = /<(select|insert|update|delete|sql)\b((?:[^<>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/\1\s*>/g;

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Whether a file is a MyBatis mapper: its DTD, or a `<mapper namespace>` holding statements. */
export function isMapperXml(source: string): boolean {
  if (/mybatis-3-mapper\.dtd|ibatis\.apache\.org\/dtd\/ibatis-3-mapper/.test(source)) return true;
  return /<mapper\s[^>]*namespace\s*=/.test(source) && /<(select|insert|update|delete)\s[^>]*\bid\s*=/.test(source);
}

const parsed = new WeakMap<string[], ParsedMapper | null>();

export function parseMapper(lines: string[]): ParsedMapper | null {
  if (parsed.has(lines)) return parsed.get(lines)!;
  const source = lines.join("\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const ns = /<mapper\s((?:[^<>"']|"[^"]*"|'[^']*')*)>/.exec(source);
  const namespace = ns ? attr(ns[1]!, "namespace") : null;
  if (!namespace || !isMapperXml(source)) {
    parsed.set(lines, null);
    return null;
  }
  const fragments = new Map<string, string>();
  const raw: Array<{ id: string; verb: MapperStatement["verb"]; at: number; end: number; body: string }> = [];
  for (const m of source.matchAll(STATEMENT_RE)) {
    const id = attr(m[2]!, "id");
    if (!id) continue;
    if (m[1] === "sql") fragments.set(id, m[3]!);
    else raw.push({ id, verb: m[1] as MapperStatement["verb"], at: m.index!, end: m.index! + m[0].length, body: m[3]! });
  }
  const lineAt = (offset: number): number => {
    let n = 1;
    for (let i = 0; i < offset; i++) if (source.charCodeAt(i) === 10) n++;
    return n;
  };
  const expand = (body: string, depth: number): string =>
    body.replace(/<include\s((?:[^<>"']|"[^"]*"|'[^']*')*?)\/?>(?:\s*<\/include>)?/g, (_, a: string) => {
      const ref = attr(a, "refid")?.split(".").pop();
      const frag = ref ? fragments.get(ref) : undefined;
      return frag !== undefined && depth < 4 ? ` ${expand(frag, depth + 1)} ` : " ";
    });
  const statements = raw.map((s) => ({
    id: s.id,
    verb: s.verb,
    line: lineAt(s.at),
    endLine: lineAt(s.end),
    sql: expand(s.body, 0)
      .replace(/<!\[CDATA\[|\]\]>/g, " ")
      // The tags that write a keyword: `<set>` is SET, `<where>` WHERE, `<trim prefix="SET">` its prefix.
      .replace(/<(set|where)\b[^>]*>/gi, (_, k: string) => ` ${k.toUpperCase()} `)
      .replace(/<trim\b((?:[^<>"']|"[^"]*"|'[^']*')*)>/g, (_, a: string) => ` ${attr(a, "prefix") ?? ""} `)
      .replace(/<[^>]+>/g, " ")
      .replace(/[#$]\{[^}]*\}/g, "?")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim(),
  }));
  const out = { namespace, statements };
  parsed.set(lines, out);
  return out;
}

export function mapperFunctions(lines: string[]): FunctionInfo[] {
  const m = parseMapper(lines);
  if (!m) return [];
  return m.statements.map((s) => ({
    name: s.id,
    params: [],
    returnType: null,
    isAsync: false,
    isExported: true,
    decorators: [`@${s.verb}(namespace = "${m.namespace}")`],
    calls: [],
    line: s.line,
    endLine: s.endLine,
  }));
}

const JOIN_RE = /\bJOIN\s+([A-Za-z_][\w.]*)/gi;

export function mapperDataSources(lines: string[]): DataSourceInfo[] {
  const m = parseMapper(lines);
  if (!m) return [];
  const out: DataSourceInfo[] = [];
  for (const s of m.statements) {
    const found = tableFrom(s.sql);
    if (!found) continue;
    const table = found.table.split(".").pop()!;
    const access = sqlVerbAccess(found.verb);
    const seen = new Set([table.toLowerCase()]);
    out.push({ kind: "database", name: `<${s.verb}>`, target: table, entity: table, line: s.line, calls: [], ...(access ? { access } : {}) });
    if (s.verb !== "select") continue;
    for (const j of s.sql.matchAll(JOIN_RE)) {
      const t = j[1]!.split(".").pop()!;
      if (seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      out.push({ kind: "database", name: "<select>", target: t, entity: t, line: s.line, calls: [], access: "read" });
    }
  }
  return out;
}
