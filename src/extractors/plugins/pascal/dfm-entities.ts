import type { ClassInfo, EntityRelation, FileAnalysis, PropertyInfo } from "../../../types/analysis.js";
import { EntityExtractor, SYNTHETIC_ENTITY, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";

/**
 * Data-model extraction for Delphi forms and data modules.
 *
 * A Delphi/Firebird codebase keeps no schema in the repo — no migrations, no
 * DDL, no ORM classes. The schema lives in the database. But the IDE persists
 * enough of it into every `.dfm` to reconstruct the tables the app actually
 * uses:
 *
 *     object dsPlayerInfo: TpFIBDataSet
 *       UpdateSQL.Strings = ('UPDATE COACH SET INITIALS = :INITIALS, …')
 *       InsertSQL.Strings = ('INSERT INTO COACH (ID, INITIALS, …) VALUES …')
 *       object dsPlayerInfoINITIALS: TStringField
 *         FieldName = 'INITIALS'
 *         Size = 10
 *       end
 *     end
 *
 * The dataset's single-table DML names the table AND enumerates its writable
 * columns; the persistent `TField` children carry each column's type and width.
 * Together they give a real ER node — name, columns, types — where the raw-SQL
 * fallback (`synthesizeReferencedTableEntities`) could only give a bare name.
 *
 * ## Why columns come from the DML, not from the field list
 *
 * A dataset's `SelectSQL` is usually a join, so its persistent fields are a
 * RESULT-SET shape, not a table shape — `dsPlayerInfo` carries `FIRSTNAME` from
 * the joined `TPERSON`, which is not a `COACH` column. Attributing every field
 * to the owning table would invent columns. So the authoritative column set is
 * whatever single-table DML the dataset declares (INSERT column list, UPDATE
 * SET list, single-table SELECT), and the field list only supplies TYPES for
 * columns already established that way. Datasets whose only SQL is a
 * multi-table SELECT contribute relations but no table.
 *
 * ## Relations
 *
 * Firebird FK metadata isn't in the repo either, and team-desk uses no
 * `MasterFields`/`MasterSource` wiring — so join predicates are the only
 * relationship signal: `INNER JOIN TEAM T ON T.ID = TL.TEAM_ID` is a
 * `TEAM_PLAYER → TEAM` many-to-one. Emitted with orm `"ci-query"` so they are
 * picked up BOTH by `buildEntityGraph` (when both ends are real table entities)
 * and by `synthesizeReferencedTableEntities` (when one end is only known as an
 * inferred node from a raw-SQL access).
 *
 * Fed from the DFM object tree that `parseDfm` has already built — the `.dfm`
 * is parsed once, not twice.
 */

/** The subset of the DFM parser's object tree this extractor reads. */
export interface DfmObjectNode {
  name: string;
  type: string;
  line: number;
  propValues: Map<string, string>;
  dbProps: { prop: string; value: string; line: number }[];
  parentIndex: number | null;
}

/** Marks the entities/relations this module produces, for the cross-file merge. */
export const DFM_ORM = "dfm";

/**
 * Persistent `TField` class → SQL type. Delphi's field classes ARE the column
 * types: the IDE generates them from the server's metadata when the developer
 * adds persistent fields, so this mapping recovers the real declared type.
 */
const FIELD_TYPES: Record<string, string> = {
  integerfield: "integer",
  autoincfield: "integer",
  largeintfield: "bigint",
  smallintfield: "smallint",
  shortintfield: "smallint",
  wordfield: "integer",
  bytefield: "smallint",
  stringfield: "varchar",
  widestringfield: "varchar",
  memofield: "text",
  widememofield: "text",
  blobfield: "blob",
  graphicfield: "blob",
  bytesfield: "blob",
  varbytesfield: "blob",
  floatfield: "double precision",
  singlefield: "float",
  extendedfield: "double precision",
  currencyfield: "currency",
  bcdfield: "numeric",
  fmtbcdfield: "numeric",
  datetimefield: "timestamp",
  sqltimestampfield: "timestamp",
  datefield: "date",
  timefield: "time",
  booleanfield: "boolean",
  guidfield: "uuid",
  variantfield: "variant",
};

/**
 * Data-access vendors subclass the whole `TField` hierarchy under their own
 * prefix — FIBPlus writes `TFIBStringField`, IBX `TIBBCDField`, FireDAC
 * `TFDStringField` — for the SAME underlying types. Strip the leading `T` and a
 * known vendor prefix so one table covers every vendor.
 */
const FIELD_VENDOR_PREFIXES = ["fib", "ib", "fd", "ado", "sql", "zeos", "jv", "dx", "cx"];

/** SQL type for a persistent field class, or null when it isn't a field class. */
function fieldTypeOf(componentType: string): string | null {
  const t = componentType.toLowerCase();
  if (!t.startsWith("t") || !t.endsWith("field")) return null;
  const rest = t.slice(1);
  const direct = FIELD_TYPES[rest];
  if (direct) return direct;
  for (const prefix of FIELD_VENDOR_PREFIXES) {
    if (rest.startsWith(prefix)) {
      const stripped = FIELD_TYPES[rest.slice(prefix.length)];
      if (stripped) return stripped;
    }
  }
  return null;
}

/** SQL-bearing dataset properties, in the order we trust them for table identity. */
const DML_PROPS = [
  "UpdateSQL.Strings", "ModifySQL.Strings", "InsertSQL.Strings", "DeleteSQL.Strings",
] as const;
const SELECT_PROPS = [
  "SelectSQL.Strings", "SQL.Strings", "RefreshSQL.Strings", "CommandText.Strings",
] as const;

/** Words that can follow a table name but are never an alias. */
const NOT_AN_ALIAS = new Set([
  "where", "order", "group", "having", "join", "inner", "left", "right", "full",
  "outer", "cross", "on", "union", "set", "values", "into", "as", "limit",
  "offset", "rows", "plan", "for", "with", "returning", "natural", "using",
]);

/** Reserved words that must never be read as a table name. */
const NOT_A_TABLE = new Set([
  "select", "where", "set", "values", "from", "join", "on", "as", "and", "or",
  "if", "not", "exists", "into", "table", "order", "group", "by", "distinct",
]);

/** Bare table name: drops a schema qualifier and surrounding quotes. */
function bareTable(raw: string): string | null {
  const name = raw.trim().replace(/["`[\]]/g, "").split(".").pop() ?? "";
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  if (NOT_A_TABLE.has(name.toLowerCase())) return null;
  return name;
}

/** A plain column reference (`FIRSTNAME` or `L.FIRSTNAME`) — not an expression. */
function bareColumn(raw: string): string | null {
  const t = raw.trim().replace(/["`[\]]/g, "");
  const m = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)$/.exec(t);
  if (!m) return null;
  const col = m[1]!;
  return NOT_A_TABLE.has(col.toLowerCase()) ? null : col;
}

/** Split a comma-separated SQL list, ignoring commas nested in parentheses. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** `UPDATE <table> SET a = :a, b = :b [WHERE …]` → the table and its SET columns. */
function parseUpdate(sql: string): { table: string; columns: string[] } | null {
  const m = /\bUPDATE\s+([\w$."`[\]]+)\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i.exec(sql);
  if (!m) return null;
  const table = bareTable(m[1]!);
  if (!table) return null;
  const columns: string[] = [];
  for (const assignment of splitTopLevel(m[2]!)) {
    const lhs = assignment.split("=")[0];
    if (lhs === undefined) continue;
    const col = bareColumn(lhs);
    if (col) columns.push(col);
  }
  return { table, columns };
}

/** `INSERT INTO <table> (a, b, c) VALUES (…)` → the table and its column list. */
function parseInsert(sql: string): { table: string; columns: string[] } | null {
  const m = /\bINSERT\s+INTO\s+([\w$."`[\]]+)\s*\(([^)]*)\)/i.exec(sql);
  if (!m) return null;
  const table = bareTable(m[1]!);
  if (!table) return null;
  const columns: string[] = [];
  for (const part of splitTopLevel(m[2]!)) {
    const col = bareColumn(part);
    if (col) columns.push(col);
  }
  return { table, columns };
}

/** `DELETE FROM <table> …` → the table (no columns). */
function parseDelete(sql: string): { table: string; columns: string[] } | null {
  const m = /\bDELETE\s+FROM\s+([\w$."`[\]]+)/i.exec(sql);
  if (!m) return null;
  const table = bareTable(m[1]!);
  return table ? { table, columns: [] } : null;
}

/**
 * Every table a query reads, in query order, with its alias when one is
 * declared.
 *
 * Firebird's SELECTABLE STORED PROCEDURES are invoked in exactly the table
 * position — `FROM SP_WAITLIST(:CLUB_ID, :MATCH_DATE)` — and team-desk leans on them
 * heavily. They are not tables and must not become ER nodes, so a name followed
 * by an argument list is skipped.
 */
function queryTables(sql: string): { table: string; alias: string | null }[] {
  const out: { table: string; alias: string | null }[] = [];
  const re = /\b(?:FROM|JOIN)\s+([\w$."`[\]]+)\s*(\()?(?:\s*(?:AS\s+)?([A-Za-z_]\w*))?/gi;
  for (const m of sql.matchAll(re)) {
    if (m[2]) continue; // `NAME(` — a selectable stored procedure, not a table
    const table = bareTable(m[1]!);
    if (!table) continue;
    const rawAlias = m[3];
    const alias = rawAlias && !NOT_AN_ALIAS.has(rawAlias.toLowerCase()) ? rawAlias : null;
    out.push({ table, alias });
  }
  return out;
}

/**
 * Column list of a SELECT, but only when it reads exactly one table — a join's
 * select list mixes columns from several tables and cannot be attributed.
 * Expressions (`A || B as X`, `COALESCE(…)`) are skipped; only plain column
 * references become columns.
 */
function parseSingleTableSelect(sql: string): { table: string; columns: string[] } | null {
  const tables = queryTables(sql);
  const distinct = new Set(tables.map((t) => t.table.toLowerCase()));
  if (distinct.size !== 1) return null;
  const table = tables[0]!.table;

  const m = /\bSELECT\s+((?:FIRST\s+\S+\s+|SKIP\s+\S+\s+|DISTINCT\s+)*)([\s\S]*?)\bFROM\b/i.exec(sql);
  if (!m) return { table, columns: [] };
  const columns: string[] = [];
  for (const part of splitTopLevel(m[2]!)) {
    const col = bareColumn(part);
    if (col) columns.push(col);
  }
  return { table, columns };
}

/** Uppercase key for case-insensitive column matching (Firebird folds case). */
const colKey = (name: string): string => name.toUpperCase();

/** Persistent `TField` children of a dataset → column name → SQL type. */
function fieldTypes(fields: DfmObjectNode[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const f of fields) {
    const fieldName = f.propValues.get("FieldName");
    if (!fieldName) continue;
    const name = fieldName.replace(/^'(.*)'$/, "$1").trim();
    if (!/^[A-Za-z_]\w*$/.test(name)) continue;
    const base = fieldTypeOf(f.type);
    if (!base) continue;
    const size = Number(f.propValues.get("Size"));
    const type = base === "varchar" && Number.isFinite(size) && size > 0 ? `varchar(${size})` : base;
    types.set(colKey(name), type);
  }
  return types;
}

/**
 * Relations from join predicates. `ON T.ID = TL.TEAM_ID` with aliases resolved
 * is a `TEAM_PLAYER.TEAM_ID → TEAM` many-to-one: the side whose column is the
 * bare primary key (`ID`) is the ONE end, the other side owns the foreign key.
 */
function joinRelations(sql: string, seen: Set<string>): EntityRelation[] {
  const byAlias = new Map<string, string>();
  // Position in the FROM/JOIN sequence — the tiebreak when neither side of the
  // predicate is a bare `ID`: the table introduced LATER is the one being joined
  // TO (the lookup/parent), e.g. `FROM TPERSON FAR JOIN TPOSTTOWN FARBY ON
  // FARBY.POSTCODE = FAR.POSTCODE` is TPERSON.POSTCODE → TPOSTTOWN, not the reverse.
  const position = new Map<string, number>();
  queryTables(sql).forEach(({ table, alias }, i) => {
    const key = (alias ?? table).toLowerCase();
    byAlias.set(key, table);
    if (!position.has(key)) position.set(key, i);
    if (!byAlias.has(table.toLowerCase())) {
      byAlias.set(table.toLowerCase(), table);
      position.set(table.toLowerCase(), i);
    }
  });

  const relations: EntityRelation[] = [];
  const re = /\bON\s+([\w$]+)\.([\w$]+)\s*=\s*([\w$]+)\.([\w$]+)/gi;
  for (const m of sql.matchAll(re)) {
    const leftTable = byAlias.get(m[1]!.toLowerCase());
    const rightTable = byAlias.get(m[3]!.toLowerCase());
    if (!leftTable || !rightTable) continue;
    if (leftTable.toLowerCase() === rightTable.toLowerCase()) continue; // self-join
    const leftCol = m[2]!;
    const rightCol = m[4]!;

    // The bare `ID` side is the parent; the other side carries the FK column.
    let fromTable: string, toTable: string, fk: string;
    if (leftCol.toUpperCase() === "ID" && rightCol.toUpperCase() !== "ID") {
      fromTable = rightTable; toTable = leftTable; fk = rightCol;
    } else if (rightCol.toUpperCase() === "ID" && leftCol.toUpperCase() !== "ID") {
      fromTable = leftTable; toTable = rightTable; fk = leftCol;
    } else {
      // No PK side to go on (`POSTCODE = POSTCODE`, or `ID = ID`) — the table
      // introduced later in the query is the one being looked up.
      const leftPos = position.get(m[1]!.toLowerCase()) ?? 0;
      const rightPos = position.get(m[3]!.toLowerCase()) ?? 0;
      if (leftPos > rightPos) {
        fromTable = rightTable; toTable = leftTable; fk = rightCol;
      } else {
        fromTable = leftTable; toTable = rightTable; fk = leftCol;
      }
    }

    const key = `${fromTable.toLowerCase()}|${toTable.toLowerCase()}|${fk.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    relations.push({
      fromEntity: fromTable,
      fromField: fk,
      toEntity: toTable,
      cardinality: "many-to-one",
      foreignKey: fk,
      // `ci-query` is the engine's tag for "relation derived from a query join,
      // not from declared schema" — it routes these through the inferred-table
      // edge pass as well, so a join to a table no DFM models still draws.
      orm: "ci-query",
      confidence: "INFERRED",
    });
  }
  return relations;
}

/**
 * Build table entities + relations from one parsed `.dfm` object tree.
 * Returns empty for forms that declare no SQL — the overwhelming majority.
 */
export function extractDfmEntities(
  objects: DfmObjectNode[],
): { entities: ClassInfo[]; relations: EntityRelation[] } {
  const withSql = objects.some((o) => o.dbProps.length > 0);
  if (!withSql) return { entities: [], relations: [] };

  // Persistent TField children, grouped by their owning dataset.
  const fieldsByParent = new Map<number, DfmObjectNode[]>();
  objects.forEach((obj) => {
    if (obj.parentIndex === null) return;
    if (!fieldTypeOf(obj.type)) return;
    const list = fieldsByParent.get(obj.parentIndex) ?? [];
    list.push(obj);
    fieldsByParent.set(obj.parentIndex, list);
  });

  // One record per physical table, merged across the datasets that touch it.
  interface Table { name: string; columns: Map<string, string | null>; line: number }
  const tables = new Map<string, Table>();
  const relations: EntityRelation[] = [];
  const seenRelations = new Set<string>();

  objects.forEach((obj, index) => {
    if (obj.dbProps.length === 0) return;
    const sqlByProp = new Map<string, { value: string; line: number }>();
    for (const p of obj.dbProps) {
      if (!sqlByProp.has(p.prop)) sqlByProp.set(p.prop, { value: p.value, line: p.line });
    }

    // Relations from every query on this dataset, whether or not it owns a table.
    for (const { value } of sqlByProp.values()) {
      relations.push(...joinRelations(value, seenRelations));
    }

    // Authoritative single-table statements, most trustworthy first.
    const claims: { table: string; columns: string[]; line: number }[] = [];
    for (const prop of DML_PROPS) {
      const entry = sqlByProp.get(prop);
      if (!entry) continue;
      const parsed = prop.startsWith("Update") || prop.startsWith("Modify")
        ? parseUpdate(entry.value)
        : prop.startsWith("Insert")
          ? parseInsert(entry.value)
          : parseDelete(entry.value);
      if (parsed) claims.push({ ...parsed, line: entry.line });
    }
    // Whether any query on this dataset reads more than one table. If so its
    // persistent fields are a join's result shape and cannot be attributed.
    let joins = false;
    for (const prop of SELECT_PROPS) {
      const entry = sqlByProp.get(prop);
      if (!entry) continue;
      const parsed = parseSingleTableSelect(entry.value);
      if (parsed) claims.push({ ...parsed, line: entry.line });
      else if (new Set(queryTables(entry.value).map((t) => t.table.toLowerCase())).size > 1) {
        joins = true;
      }
    }
    // TTable/TFDTable name the table outright.
    const tableName = obj.dbProps.find((p) => p.prop === "TableName");
    if (tableName) {
      const t = bareTable(tableName.value);
      if (t) claims.push({ table: t, columns: [], line: tableName.line });
    }
    if (claims.length === 0) return;

    // Types for this dataset's persistent fields, applied to whichever of its
    // claimed columns they name.
    const types = fieldTypes(fieldsByParent.get(index) ?? []);

    // A dataset that touches exactly one table, and never joins, has no source
    // for its persistent fields other than that table — so the whole field list
    // is the table's columns. The moment a join appears, the field list is a
    // result shape and only the DML column lists can be trusted.
    const claimedNames = new Set(claims.map((c) => c.table.toLowerCase()));
    const soleTable = !joins && claimedNames.size === 1 ? claims[0]!.table : null;

    for (const claim of claims) {
      const key = claim.table.toLowerCase();
      let table = tables.get(key);
      if (!table) {
        table = { name: claim.table, columns: new Map(), line: claim.line };
        tables.set(key, table);
      }
      for (const col of claim.columns) {
        const existing = table.columns.get(colKey(col));
        table.columns.set(colKey(col), existing ?? types.get(colKey(col)) ?? null);
      }
    }
    if (soleTable) {
      const table = tables.get(soleTable.toLowerCase())!;
      for (const [col, type] of types) {
        if (!table.columns.has(col)) table.columns.set(col, type);
      }
    }
    // Back-fill types onto columns THIS dataset claimed — a column named by an
    // INSERT list is typed by the matching persistent field. Restricted to the
    // claimed tables so one dataset's field types never leak onto another's.
    for (const name of claimedNames) {
      const table = tables.get(name);
      if (!table) continue;
      for (const [col, type] of table.columns) {
        if (type === null && types.has(col)) table.columns.set(col, types.get(col)!);
      }
    }
  });

  const entities: ClassInfo[] = [...tables.values()].map((t) => {
    const properties: PropertyInfo[] = [...t.columns].map(([name, type]) => ({
      name,
      type,
      visibility: "public" as const,
      isStatic: false,
      isReadonly: false,
    }));
    return {
      name: t.name,
      extends: null,
      implements: [],
      // SYNTHETIC_ENTITY: this is a table read out of the dataset's DML, not a
      // Pascal type — it belongs in the Data Model, not in the class graph.
      decorators: ["entity", DFM_ORM, SYNTHETIC_ENTITY],
      methods: [],
      properties,
      isExported: true,
      line: t.line,
      endLine: t.line,
    };
  });

  // A table with no columns adds nothing the raw-SQL fallback doesn't already
  // give — leave those to `synthesizeReferencedTableEntities`.
  return { entities: entities.filter((e) => e.properties.length > 0), relations };
}

/**
 * Project-level merge for DFM tables.
 *
 * The same physical table is modelled by a dataset on every form that touches
 * it — `COACH` appears in a dozen `.dfm`s, each with the column subset that
 * form writes. Left alone, `buildEntityGraph` (which keys nodes by
 * `file::name`) would render a dozen partial `COACH` nodes. This collapses them
 * into ONE entity carrying the union of the columns, in the file that knows the
 * most about it.
 *
 * NOTE ON WIRING: `.dfm` files go through `customParse`, which does not run the
 * per-file `extract()` path — `parseDfm` calls `extractDfmEntities` directly
 * with the object tree it already has. This class exists for `reconcileProject`,
 * which core DOES call for every registered plugin regardless of parse mode, and
 * which is the only place a cross-file merge can happen. `extract()` is
 * deliberately a no-op.
 */
export class DfmEntityExtractor extends EntityExtractor {
  readonly languages = ["dfm" as const];

  extract(_ctx: EntityExtractContext): EntityExtractResult {
    return { entities: [], relations: [] };
  }

  override reconcileProject(analyses: FileAnalysis[]): void {
    // Gather every DFM-derived entity, keyed by table name.
    const byTable = new Map<string, { analysis: FileAnalysis; cls: ClassInfo }[]>();
    for (const a of analyses) {
      for (const cls of a.classes ?? []) {
        if (!cls.decorators?.includes(DFM_ORM)) continue;
        const key = cls.name.toLowerCase();
        const list = byTable.get(key) ?? [];
        list.push({ analysis: a, cls });
        byTable.set(key, list);
      }
    }

    for (const declarations of byTable.values()) {
      if (declarations.length < 2) continue;
      // The declaration with the most columns wins; ties break on file path so
      // the choice is stable across runs.
      const winner = declarations.reduce((best, d) =>
        d.cls.properties.length > best.cls.properties.length ||
        (d.cls.properties.length === best.cls.properties.length &&
          d.analysis.filePath < best.analysis.filePath)
          ? d
          : best,
      );
      const columns = new Map(winner.cls.properties.map((p) => [p.name, p]));
      for (const d of declarations) {
        if (d === winner) continue;
        for (const p of d.cls.properties) {
          const existing = columns.get(p.name);
          // A typed column beats an untyped one from a DML-only declaration.
          if (!existing) columns.set(p.name, p);
          else if (existing.type === null && p.type !== null) columns.set(p.name, p);
        }
        // Drop the duplicate node — these are synthetic entities this extractor
        // added, so removing them takes nothing the .dfm actually declared.
        d.analysis.classes = d.analysis.classes.filter((c) => c !== d.cls);
      }
      winner.cls.properties = [...columns.values()];
    }
  }
}

export const dfmEntityExtractor = new DfmEntityExtractor();
