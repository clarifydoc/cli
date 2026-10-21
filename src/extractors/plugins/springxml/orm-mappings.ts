import type { FunctionInfo } from "../../../types/analysis.js";

/**
 * JPA `orm.xml` mapping files: the named queries they declare, as the
 * annotation form spells them, so the JVM entity pass resolves the calls that
 * run them by name the same way —
 *
 *   <entity-mappings>
 *     <named-query name="club.byLeague"><query>select c from Club c where …</query></named-query>
 *     <entity class="com.example.league.Match"><named-native-query name="match.raw" result-class="…">
 *
 * Each becomes a function named for the query, decorated
 * `NamedQuery(name = "…", query = "…")` (`NamedNativeQuery` with its
 * `resultClass`, or the enclosing `<entity class>`'s simple name as the
 * declaring class).
 */

export function isOrmMappingXml(source: string): boolean {
  return /<entity-mappings[\s>]/.test(source) && /<named-(?:native-)?query\b/.test(source);
}

const QUERY_RE = /<(named-query|named-native-query)\s([^>]*)>([\s\S]*?)<\/\1>/g;
const ENTITY_RE = /<entity\s[^>]*\bclass\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/entity>/g;

const attr = (attrs: string, name: string): string | null => new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1] ?? null;
const simple = (type: string): string => type.replace(/^.*\./, "");

export function ormMappingFunctions(lines: string[]): FunctionInfo[] {
  const source = lines.join("\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  if (!isOrmMappingXml(source)) return [];
  // Each query's declaring entity: the `<entity class>` it sits in, by offset.
  const owners: Array<{ from: number; to: number; cls: string }> = [];
  for (const e of source.matchAll(ENTITY_RE)) owners.push({ from: e.index!, to: e.index! + e[0].length, cls: simple(e[1]!) });
  const out: FunctionInfo[] = [];
  for (const m of source.matchAll(QUERY_RE)) {
    const name = attr(m[2]!, "name");
    if (!name) continue;
    const query = (/<query>([\s\S]*?)<\/query>/.exec(m[3]!)?.[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\s+/g, " ").trim();
    const owner = owners.find((o) => m.index! >= o.from && m.index! < o.to);
    const resultClass = attr(m[2]!, "result-class");
    const native = m[1] === "named-native-query";
    const args = [`name = "${name}"`, `query = "${query.replace(/"/g, "'")}"`, ...(resultClass ? [`resultClass = ${simple(resultClass)}.class`] : [])];
    const line = source.slice(0, m.index!).split("\n").length;
    out.push({
      name,
      params: [],
      returnType: null,
      isAsync: false,
      isExported: true,
      decorators: [`${native ? "NamedNativeQuery" : "NamedQuery"}(${args.join(", ")})`, ...(owner ? [`@entity("${owner.cls}")`] : [])],
      calls: [],
      line,
      endLine: line + m[0].split("\n").length - 1,
    });
  }
  return out;
}
