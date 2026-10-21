import type { ClassInfo, DataSourceInfo, EntityRelation, FileAnalysis, FunctionInfo, PropertyInfo } from "../../../types/analysis.js";
import { EntityExtractor, SYNTHETIC_ENTITY, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { companionStem } from "./companion.js";

/**
 * Data-model extraction for Delphi forms and data modules.
 *
 * A Delphi/Firebird codebase keeps no schema in the repo — no migrations, no
 * DDL, no ORM classes. The schema lives in the database. But the IDE persists
 * enough of it into every `.dfm` to reconstruct the tables the app actually
 * uses:
 *
 *     object dsPlayerInfo: TpFIBDataSet
 *       UpdateSQL.Strings = ('UPDATE PLAYER SET SHIRT_NAME = :SHIRT_NAME, …')
 *       InsertSQL.Strings = ('INSERT INTO PLAYER (ID, SHIRT_NAME, …) VALUES …')
 *       object dsPlayerInfoSHIRT_NAME: TStringField
 *         FieldName = 'SHIRT_NAME'
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
 * RESULT-SET shape, not a table shape — `dsPlayerInfo` carries `CLUB_NAME` from
 * the joined `TCLUB`, which is not a `PLAYER` column. Attributing every field
 * to the owning table would invent columns. So the authoritative column set is
 * whatever single-table DML the dataset declares (INSERT column list, UPDATE
 * SET list, single-table SELECT), and the field list only supplies TYPES for
 * columns already established that way. Datasets whose only SQL is a
 * multi-table SELECT contribute relations but no table.
 *
 * ## Relations
 *
 * Firebird FK metadata isn't in the repo either, and these apps use no
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

/** A plain column reference (`CLUB_NAME` or `C.CLUB_NAME`) — not an expression. */
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
 * position — `FROM SP_FIXTURES(:CLUB_ID, :MATCH_DATE)` — and Firebird apps lean on them
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
  // TO (the lookup/parent), e.g. `FROM PLAYER P JOIN TSTADIUM ST ON
  // ST.STADIUM_CODE = P.STADIUM_CODE` is PLAYER.STADIUM_CODE → TSTADIUM, not the reverse.
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
      // No PK side to go on (`STADIUM_CODE = STADIUM_CODE`, or `ID = ID`) — the table
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
 * it — `PLAYER` appears in a dozen `.dfm`s, each with the column subset that
 * form writes. Left alone, `buildEntityGraph` (which keys nodes by
 * `file::name`) would render a dozen partial `PLAYER` nodes. This collapses them
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
    const tablesByForm = joinUnitAccessesToFormTables(analyses);
    followDatasetParameters(analyses, tablesByForm);
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
        // Its column type references go with it. They describe a class the file
        // no longer declares, and the class-graph aggregator re-creates a node
        // for any reference whose `sourceClass` it doesn't recognise — which
        // would put the duplicate straight back. A `.dfm` declares no Pascal
        // type, so the only class this name can mean here is the one just cut.
        if (d.analysis.typeReferences?.length) {
          d.analysis.typeReferences = d.analysis.typeReferences.filter(
            (r) => r.sourceClass !== d.cls.name,
          );
        }
      }
      winner.cls.properties = [...columns.values()];
    }
  }
}

export const dfmEntityExtractor = new DfmEntityExtractor();

/**
 * A unit's dataset access names the COMPONENT (`qryFixtures.Open`,
 * `dsFixtures.FieldByName(…)` → target `qryFixtures`); the table is in the
 * companion `.dfm`, whose rows are named `<component>: <VERB>` with the table
 * as entity. Join the two: the `.pas` row gets the table its component reads,
 * and the form's handler then reaches the table in Call Traces (on one real
 * codebase, 3,400 of 4,200 Pascal accesses carried no entity). Only the companion form (same
 * path, `.dfm`) is consulted — a component name is local to its form.
 */
function joinUnitAccessesToFormTables(analyses: FileAnalysis[]): Map<string, Map<string, string>> {
  const tablesByForm = new Map<string, Map<string, string>>();
  // A component whose query's own source is a stored procedure
  // (`SelectSQL = 'SELECT … FROM SP_SQUAD(:A)'`): the unit's `dsSquad.Open`
  // calls that procedure.
  const routinesByForm = new Map<string, Map<string, string>>();
  for (const a of analyses) {
    if (a.language !== "dfm") continue;
    const byComponent = new Map<string, string>();
    const routines = new Map<string, string>();
    for (const ds of a.dataSources) {
      // A joined table is beside the statement's own; it does not say which
      // table the component is.
      if (ds.kind !== "database" || ds.joined) continue;
      const component = /^(\w+):\s/.exec(ds.name)?.[1];
      if (!component) continue;
      const key = component.toLowerCase();
      if (ds.routine && ds.target) {
        const known = routines.get(key);
        if (known && known !== ds.target) routines.set(key, "");
        else if (!known) routines.set(key, ds.target);
        continue;
      }
      if (!ds.entity) continue;
      const known = byComponent.get(key);
      if (known && known !== ds.entity) byComponent.set(key, ""); // several tables: no single answer
      else if (!known) byComponent.set(key, ds.entity);
    }
    tablesByForm.set(companionStem(a.filePath), byComponent);
    routinesByForm.set(companionStem(a.filePath), routines);
  }
  if (tablesByForm.size === 0) return tablesByForm;
  for (const a of analyses) {
    if (a.language !== "pascal") continue;
    const form = tablesByForm.get(companionStem(a.filePath));
    const routines = routinesByForm.get(companionStem(a.filePath));
    if (!form || (form.size === 0 && !routines?.size)) continue;
    let changed = false;
    const next: DataSourceInfo[] = a.dataSources.map((ds) => {
      if (ds.kind !== "database" || ds.entity || ds.routine || !ds.target) return ds;
      const component = ds.target.split(".").pop()!.toLowerCase();
      const table = form.get(component);
      if (table) {
        changed = true;
        return { ...ds, entity: table };
      }
      const routine = routines?.get(component);
      if (!routine || table === "") return ds;
      changed = true;
      return { ...ds, target: routine, routine: true };
    });
    if (changed) a.dataSources = next;
  }
  return tablesByForm;
}

/**
 * A routine that takes a dataset (`procedure FillGrid(DataSet: TDataSet)`) reads
 * `DataSet.FieldByName(…)` on whatever its callers pass — so those rows name no
 * table of their own (1,400 rows on one shared report routine, in one real codebase). Follow the
 * argument back: a call that passes a component (`FillGrid(qryPupils)`,
 * `srcPupils.DataSet`) reads the table that component reads in its own form, and
 * a local whose SQL the calling routine sets reads that SQL's table. Only when
 * EVERY call site's argument resolves, all to the same table, do the routine's
 * rows on that parameter take it: an in-memory dataset, a component of another
 * form or a second table leaves them as they were. The callee is the one routine
 * of the call's name whose parameter count admits the arguments (overloads by
 * arity), the caller's own unit first.
 */
function followDatasetParameters(analyses: FileAnalysis[], tablesByForm: Map<string, Map<string, string>>): void {
  interface Routine { analysis: FileAnalysis; fn: FunctionInfo; byParam: Map<number, DataSourceInfo[]> }
  const routinesOf = (a: FileAnalysis): FunctionInfo[] => [...a.functions, ...a.classes.flatMap((c) => c.methods)];
  const units = analyses.filter((a) => a.language === "pascal");
  const dbRows = new Map(units.map((a) => [a, a.dataSources.filter((ds) => ds.kind === "database")]));
  const byLeaf = new Map<string, Routine[]>();
  for (const a of units) {
    const unnamed = dbRows.get(a)!.filter((ds) => !ds.entity);
    if (unnamed.length === 0) continue;
    for (const fn of routinesOf(a)) {
      if (fn.params.length === 0) continue;
      const byParam = new Map<number, DataSourceInfo[]>();
      for (const ds of unnamed) {
        if (ds.line < fn.line || ds.line > fn.endLine) continue;
        const receiver = ds.name.slice(0, Math.max(0, ds.name.lastIndexOf("."))).toLowerCase();
        const index = fn.params.findIndex((p) => p.name.toLowerCase() === receiver);
        if (index >= 0) (byParam.get(index) ?? byParam.set(index, []).get(index)!).push(ds);
      }
      if (byParam.size === 0) continue;
      const leaf = fn.name.split(".").pop()!.toLowerCase();
      (byLeaf.get(leaf) ?? byLeaf.set(leaf, []).get(leaf)!).push({ analysis: a, fn, byParam });
    }
  }
  if (byLeaf.size === 0) return;

  // A routine's parameter resolved in an earlier round (`LoadFromQuery(Query)` where
  // `Query` is the caller's own dataset parameter): routine → lowercased name → table.
  const resolvedParam = new Map<FunctionInfo, Map<string, string>>();
  // What does not change between rounds: the table a name reads within one routine
  // through the caller's form or the routine's own query (null = none).
  const localTables = new Map<FunctionInfo, Map<string, string | null>>();
  const localTable = (name: string, caller: FileAnalysis, routine: FunctionInfo): string | null => {
    const memo = localTables.get(routine) ?? localTables.set(routine, new Map()).get(routine)!;
    if (memo.has(name)) return memo.get(name)!;
    let table = tablesByForm.get(companionStem(caller.filePath))?.get(name) || null;
    if (!table) {
      // A local dataset the calling routine queries itself: the routine uses it as a
      // dataset (`qry.Open`, `qry.SQL.Add(…)`) and selects from exactly one table.
      const inRoutine = dbRows.get(caller)!.filter((ds) => ds.line >= routine.line && ds.line <= routine.endLine);
      const own = new Set(inRoutine.filter((ds) => ds.entity && (ds.target ?? "").split(".").pop()!.toLowerCase() === name).map((ds) => ds.entity!));
      const selected = new Set(inRoutine.filter((ds) => ds.entity && !ds.joined && /^SELECT\b/i.test(ds.name)).map((ds) => ds.entity!));
      const usesArg = inRoutine.some((ds) => ds.name.toLowerCase().startsWith(`${name}.`));
      table = own.size === 1 ? [...own][0]! : usesArg && selected.size === 1 ? [...selected][0]! : null;
    }
    memo.set(name, table);
    return table;
  };
  /** The table an argument stands for, at a call in `routine` of `caller`, or null. */
  const tableOf = (arg: string | null, caller: FileAnalysis, routine: FunctionInfo): string | null => {
    const name = arg?.replace(/\.DataSet$/i, "").toLowerCase();
    if (!name || !/^[a-z_]\w*$/.test(name)) return null;
    return localTable(name, caller, routine) ?? resolvedParam.get(routine)?.get(name) ?? null;
  };

  // Callers are matched once; arguments are resolved per round, as a parameter
  // resolved in one round can resolve its callers' arguments in the next. A call
  // whose arguments were not reported (none looked like a dataset) still counts:
  // as an argument that does not resolve.
  interface Site { target: Routine; index: number; arg: string | null; caller: FileAnalysis; routine: FunctionInfo }
  const sites: Site[] = [];
  for (const caller of units) {
    for (const routine of routinesOf(caller)) {
      for (const call of routine.calls) {
        const all = byLeaf.get(call.name.split(".").pop()!.toLowerCase());
        if (!all) continue;
        const args = call.args;
        const candidates = args ? all.filter((r) => r.fn.params.length >= args.length) : all;
        const own = candidates.filter((r) => r.analysis === caller);
        const pool = own.length > 0 ? own : candidates;
        const exact = args ? pool.filter((r) => r.fn.params.length === args.length) : [];
        const chosen = new Set(exact.length > 0 ? exact : pool);
        if (args && chosen.size !== 1) continue;
        for (const target of chosen) {
          for (const index of target.byParam.keys()) sites.push({ target, index, arg: args?.[index] ?? null, caller, routine });
        }
      }
    }
  }

  const assign = new Map<DataSourceInfo, string>();
  for (let round = 0; round < 4; round++) {
    const passed = new Map<Routine, Map<number, Array<string | null>>>();
    for (const site of sites) {
      const byIndex = passed.get(site.target) ?? passed.set(site.target, new Map()).get(site.target)!;
      (byIndex.get(site.index) ?? byIndex.set(site.index, []).get(site.index)!).push(tableOf(site.arg, site.caller, site.routine));
    }
    let grew = false;
    for (const [routine, byIndex] of passed) {
      for (const [index, tables] of byIndex) {
        const distinct = new Set(tables);
        if (distinct.size !== 1 || distinct.has(null)) continue;
        const table = tables[0]!;
        const resolved = resolvedParam.get(routine.fn) ?? resolvedParam.set(routine.fn, new Map()).get(routine.fn)!;
        const name = routine.fn.params[index]!.name.toLowerCase();
        if (resolved.get(name) === table) continue;
        resolved.set(name, table);
        grew = true;
        for (const ds of routine.byParam.get(index) ?? []) assign.set(ds, table);
      }
    }
    if (!grew) break;
  }
  if (assign.size === 0) return;
  for (const a of units) {
    if (!a.dataSources.some((ds) => assign.has(ds))) continue;
    a.dataSources = a.dataSources.map((ds) => (assign.has(ds) ? { ...ds, entity: assign.get(ds)! } : ds));
  }
}
