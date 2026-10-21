import type { ClassInfo, FileAnalysis, ImportInfo, PropertyInfo, SchemaOp } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { fkRelation, replaySchema } from "../shared/schema-replay.js";

/**
 * Liquibase XML changelogs: the schema a Java service's database has.
 *
 *   <changeSet id="1" author="…">
 *     <createTable tableName="league_match">
 *       <column name="match_id" type="uuid"><constraints primaryKey="true"/></column>
 *       <column name="club_id" type="uuid"><constraints references="league_club(id)" foreignKeyName="fk_match_club"/></column>
 *     </createTable>
 *   </changeSet>
 *   <changeSet …><addColumn tableName="league_match"><column name="kick_off" type="timestamp"/></addColumn></changeSet>
 *
 * Per file: each `createTable` is a table class (decorated `table`, then
 * `liquibase` as its ORM), and every change the file states is a `schemaOp` —
 * `addColumn`, `dropColumn`, `renameColumn`, `dropTable`, `renameTable`,
 * `addForeignKeyConstraint` and a column's `references` / `referencedTableName`.
 * An `<include file>` / `<includeAll path>` is an import of the changelogs it
 * runs. Project-wide, each master changelog (one no other includes) is
 * replayed in the order its includes run, into the schema it ends with.
 * Inserts, updates, indexes and raw `<sql>` change no table's shape and are
 * not read.
 */

export function isLiquibaseChangelog(source: string): boolean {
  return /<databaseChangeLog[\s>]/.test(source);
}

interface Tag {
  name: string;
  attrs: string;
  close: boolean;
  selfClose: boolean;
  line: number;
}

const TAG_RE = /<(\/?)([A-Za-z][\w.:-]*)((?:[^<>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

function tagsOf(lines: string[]): Tag[] {
  const source = lines.join("\n").replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const out: Tag[] = [];
  let line = 1;
  let last = 0;
  for (const m of source.matchAll(TAG_RE)) {
    for (let i = last; i < m.index!; i++) if (source.charCodeAt(i) === 10) line++;
    last = m.index!;
    out.push({ name: m[2]!.replace(/^.*:/, ""), attrs: m[3] ?? "", close: m[1] === "/", selfClose: m[4] === "/", line });
  }
  return out;
}

const attr = (attrs: string, name: string): string | null => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs)?.[1] ?? null;

const PARSED = new WeakMap<string[], { tables: ClassInfo[]; ops: SchemaOp[]; includes: ImportInfo[] }>();

/** The tables a changelog creates, the changes it makes, and the changelogs it includes. */
function parse(lines: string[]): { tables: ClassInfo[]; ops: SchemaOp[]; includes: ImportInfo[] } {
  const cached = PARSED.get(lines);
  if (cached) return cached;
  const out = { tables: [] as ClassInfo[], ops: [] as SchemaOp[], includes: [] as ImportInfo[] };
  PARSED.set(lines, out);
  if (!isLiquibaseChangelog(lines.join("\n"))) return out;
  // The change being read: its tag, table, and the class a createTable builds.
  let change: { name: string; table: string | null; cls: ClassInfo | null; line: number } | null = null;
  let column: { name: string; type: string | null; line: number } | null = null;
  for (const t of tagsOf(lines)) {
    if (t.close) {
      if (t.name === "column") column = null;
      if (change && t.name === change.name) {
        if (change.cls) change.cls.endLine = t.line;
        change = null;
      }
      continue;
    }
    switch (t.name) {
      case "include": {
        const file = attr(t.attrs, "file");
        if (file) out.includes.push(includeImport(file, attr(t.attrs, "relativeToChangelogFile") === "true", t.line));
        break;
      }
      case "includeAll": {
        const path = attr(t.attrs, "path");
        if (path) out.includes.push(includeImport(path.replace(/\/?$/, "/"), attr(t.attrs, "relativeToChangelogFile") === "true", t.line));
        break;
      }
      case "createTable": {
        const table = attr(t.attrs, "tableName");
        if (!table) break;
        const cls: ClassInfo = { name: table, extends: null, implements: [], decorators: ["table", "liquibase"], methods: [], properties: [], isExported: true, line: t.line, endLine: t.line };
        out.tables.push(cls);
        out.ops.push({ op: "create-table", table, line: t.line });
        if (!t.selfClose) change = { name: t.name, table, cls, line: t.line };
        break;
      }
      case "addColumn":
      case "dropColumn": {
        const table = attr(t.attrs, "tableName");
        if (!table) break;
        const own = attr(t.attrs, "columnName");
        if (t.name === "dropColumn" && own) out.ops.push({ op: "drop-column", table, column: own, line: t.line });
        if (!t.selfClose) change = { name: t.name, table, cls: null, line: t.line };
        break;
      }
      case "column": {
        if (!change?.table) break;
        const name = attr(t.attrs, "name");
        if (!name) break;
        const type = attr(t.attrs, "type");
        if (change.name === "createTable") change.cls!.properties.push(columnProperty(name, type));
        else if (change.name === "addColumn") out.ops.push({ op: "add-column", table: change.table, column: name, type, line: t.line });
        else if (change.name === "dropColumn") out.ops.push({ op: "drop-column", table: change.table, column: name, line: t.line });
        if (!t.selfClose) column = { name, type, line: t.line };
        break;
      }
      case "constraints": {
        if (!change?.table || !column) break;
        // `references="league_club(id)"` (older schemas) or `referencedTableName="league_club"`.
        const to = attr(t.attrs, "referencedTableName") ?? attr(t.attrs, "references")?.replace(/\s*\(.*$/, "") ?? null;
        if (to) {
          out.ops.push({ op: "add-foreign-key", table: change.table, column: column.name, to, line: t.line });
          if (change.cls && !change.cls.implements.includes(to)) change.cls.implements.push(to);
        }
        break;
      }
      case "dropTable": {
        const table = attr(t.attrs, "tableName");
        if (table) out.ops.push({ op: "drop-table", table, line: t.line });
        break;
      }
      case "renameTable": {
        const from = attr(t.attrs, "oldTableName");
        const to = attr(t.attrs, "newTableName");
        if (from && to) out.ops.push({ op: "rename-table", table: from, to, line: t.line });
        break;
      }
      case "renameColumn": {
        const table = attr(t.attrs, "tableName");
        const from = attr(t.attrs, "oldColumnName");
        const to = attr(t.attrs, "newColumnName");
        if (table && from && to) out.ops.push({ op: "rename-column", table, column: from, to, line: t.line });
        break;
      }
      case "addForeignKeyConstraint": {
        const table = attr(t.attrs, "baseTableName");
        const to = attr(t.attrs, "referencedTableName");
        const columns = attr(t.attrs, "baseColumnNames");
        if (table && to) out.ops.push({ op: "add-foreign-key", table, ...(columns && !columns.includes(",") ? { column: columns.trim() } : {}), to, line: t.line });
        break;
      }
    }
  }
  return out;
}

function columnProperty(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}

/**
 * An include as an import: relative to the changelog (`./` added so the
 * resolver reads it so), else from the classpath (`META-INF/liquibase/…`).
 */
function includeImport(path: string, relative: boolean, line: number): ImportInfo {
  const source = relative && !path.startsWith(".") && !path.startsWith("/") ? `./${path}` : path;
  return { source, specifiers: [], isDefault: false, isNamespace: false, isType: false, line };
}

export const liquibaseClasses = (lines: string[]): ClassInfo[] => parse(lines).tables.map((c) => ({ ...c, properties: c.properties.map((p) => ({ ...p })) }));
export const liquibaseImports = (lines: string[]): ImportInfo[] => parse(lines).includes;

export class LiquibaseChangelogEntities extends EntityExtractor {
  readonly languages = ["springxml" as const];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const ops = parse(ctx.lines).ops;
    if (ops.length === 0) return { entities: [], relations: [] };
    const relations = ops.filter((o) => o.op === "add-foreign-key" && o.column && o.to).map((o) => fkRelation(o.table, o.column!, o.to!));
    return { entities: [], relations, schemaOps: ops };
  }

  /** Each master changelog's chain, replayed in the order its includes run. */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const changelogs = analyses.filter((a) => a.language === "springxml" && (a.schemaOps?.length || a.imports.length) && isChangelogPath(a));
    if (!changelogs.some((a) => a.schemaOps?.length)) return;
    const byPath = new Map(changelogs.map((a) => [a.filePath, a]));
    const includesOf = (a: FileAnalysis): FileAnalysis[] => a.imports.flatMap((imp) => resolveInclude(imp.source, a.filePath, changelogs));
    const included = new Set(changelogs.flatMap((a) => includesOf(a).map((x) => x.filePath)));
    const done = new Set<string>();
    for (const master of changelogs.filter((a) => !included.has(a.filePath))) {
      const chain: FileAnalysis[] = [];
      const seen = new Set<string>();
      const visit = (a: FileAnalysis): void => {
        if (seen.has(a.filePath)) return;
        seen.add(a.filePath);
        chain.push(a);
        for (const child of includesOf(a)) visit(child);
      };
      visit(master);
      // A changelog two masters include (per-country masters over one base) is replayed once, in the first.
      const fresh = chain.filter((a) => !done.has(a.filePath) && a.schemaOps?.length);
      for (const a of fresh) done.add(a.filePath);
      if (fresh.length > 0) replaySchema(fresh);
    }
    for (const a of changelogs) if (!done.has(a.filePath) && a.schemaOps?.length && byPath.has(a.filePath)) replaySchema([a]);
    foldMappedTables(analyses, changelogs);
  }
}

/**
 * A table an ORM entity maps (`@Table(name = "league_match")`) is that entity:
 * its changelog node yields to it, and a foreign key pointing at the table
 * points at the entity. Tables no entity maps (an outbox, a join table) stay.
 */
function foldMappedTables(analyses: FileAnalysis[], changelogs: FileAnalysis[]): void {
  const entityOf = new Map<string, string>();
  for (const a of analyses) {
    if (a.language === "springxml") continue;
    for (const c of a.classes) {
      if (c.tableName && c.decorators.includes("entity")) entityOf.set(c.tableName.split(".").pop()!.toLowerCase(), c.name);
    }
  }
  if (entityOf.size === 0) return;
  const mapped = (table: string): string | undefined => entityOf.get(table.split(".").pop()!.toLowerCase());
  for (const a of changelogs) {
    a.classes = a.classes.filter((c) => !(c.decorators.includes("liquibase") && mapped(c.name)));
    for (const c of a.classes) c.implements = c.implements.map((t) => mapped(t) ?? t);
    if (!a.entityRelations) continue;
    a.entityRelations = a.entityRelations
      .filter((r) => !mapped(r.fromEntity))
      .map((r) => (mapped(r.toEntity) ? { ...r, toEntity: mapped(r.toEntity)! } : r));
  }
}

/** Liquibase changelogs only (a Spring beans file holds no schema ops). */
function isChangelogPath(a: FileAnalysis): boolean {
  return a.classes.some((c) => c.decorators.includes("liquibase")) || (a.schemaOps?.length ?? 0) > 0 || a.imports.some((i) => /\.(?:xml|ya?ml|json|sql)$|\/$/i.test(i.source));
}

/** The changelogs an include names: a file relative to the includer, else one ending with the classpath path; a directory's files in name order. */
function resolveInclude(source: string, from: string, changelogs: FileAnalysis[]): FileAnalysis[] {
  const dir = from.slice(0, from.lastIndexOf("/") + 1);
  const relative = source.startsWith("./") ? normalize(dir + source.slice(2)) : null;
  const tail = source.replace(/^\.?\//, "");
  if (source.endsWith("/")) {
    const prefix = relative ?? null;
    return changelogs
      .filter((a) => (prefix ? a.filePath.startsWith(prefix) : a.filePath.includes(`/${tail}`) || a.filePath.startsWith(tail)) && !a.filePath.slice((prefix ?? tail).length).includes("/"))
      .sort((x, y) => (x.filePath < y.filePath ? -1 : 1));
  }
  const exact = relative ? changelogs.find((a) => a.filePath === relative) : undefined;
  if (exact) return [exact];
  const bySuffix = changelogs.filter((a) => a.filePath === tail || a.filePath.endsWith(`/${tail}`));
  return bySuffix.length === 1 ? bySuffix : [];
}

function normalize(path: string): string {
  const out: string[] = [];
  for (const seg of path.split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}
