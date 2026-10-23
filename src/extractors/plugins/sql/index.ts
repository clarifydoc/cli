import type {
  ClassInfo, FunctionInfo, ImportInfo, ExportInfo,
  PropertyInfo, ParamInfo, DataSourceInfo, RouteInfo, CallInfo,
} from "../../../types/analysis.js";
import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractCallsFromBody } from "../shared/regex-base.js";
import { namedQueries } from "./named-queries.js";

/** A name as written, quotes of every dialect removed: `accounting."order"` → `accounting.order`. */
const unquoteName = (s: string): string => s.replace(/[[\]"`]/g, "");

/**
 * SQL plugin — covers DDL (CREATE/ALTER/DROP), DML (SELECT/INSERT/UPDATE/DELETE),
 * routines (PROCEDURE/FUNCTION/TRIGGER), and common dialect commands.
 *
 * Tables / views / indexes / sequences / schemas are surfaced as ClassInfo so the
 * downstream data-model graph treats them like other type definitions.
 * Procedures / functions / triggers are surfaced as FunctionInfo.
 * SELECT / INSERT / UPDATE / DELETE / MERGE statements show up as DataSourceInfo
 * (kind="database") so they're visible in the report's Data tab.
 */

const TYPE_RE = /([A-Za-z][\w]*(?:\s*\([^)]*\))?)/;

function parseColumnLine(raw: string): PropertyInfo | null {
  const line = raw.replace(/,$/, "").trim();
  if (!line) return null;
  // Skip table-level constraints — they start with a keyword, not an identifier.
  if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|INDEX|KEY|FULLTEXT|SPATIAL)\b/i.test(line)) {
    return null;
  }
  // `column_name TYPE ...` or `[column_name] TYPE ...` or `"column_name" TYPE ...`
  const m = line.match(/^(?:\[([^\]]+)\]|"([^"]+)"|`([^`]+)`|([A-Za-z_]\w*))\s+/);
  if (!m) return null;
  const name = m[1] ?? m[2] ?? m[3] ?? m[4]!;
  const rest = line.slice(m[0].length).trim();
  const typeMatch = rest.match(TYPE_RE);
  const type = typeMatch ? typeMatch[1].toUpperCase().replace(/\s+/g, "") : null;
  const isReadonly = /\bGENERATED\s+ALWAYS\b/i.test(line) || /\bCOMPUTED\b/i.test(line);
  return {
    name,
    type,
    visibility: "public",
    isStatic: false,
    isReadonly,
  };
}

function parseSqlParam(paramText: string): ParamInfo | null {
  const trimmed = paramText.trim();
  if (!trimmed) return null;
  // `@name TYPE` (T-SQL), `IN name TYPE` / `OUT name TYPE` (PL/pgSQL, PL/SQL),
  // `name IN TYPE` (Oracle), or bare `name TYPE`.
  const cleaned = trimmed
    .replace(/^(IN|OUT|INOUT|IN\s+OUT)\s+/i, "")
    .replace(/\s+(IN|OUT|INOUT|IN\s+OUT)\s+/i, " ");
  const m = cleaned.match(/^@?([A-Za-z_]\w*)\s+([A-Za-z][\w]*(?:\s*\([^)]*\))?)/);
  if (!m) {
    const bare = cleaned.match(/^@?([A-Za-z_]\w*)/);
    if (!bare) return null;
    return { name: bare[1], type: null, defaultValue: null };
  }
  const dflt = cleaned.match(/(?:DEFAULT|:?=)\s*(.+)$/i);
  return {
    name: m[1],
    type: m[2].toUpperCase().replace(/\s+/g, ""),
    defaultValue: dflt ? dflt[1].trim() : null,
  };
}

/** Find the closing `)` matching the first `(` from startIdx. Returns last line. */
function findParenEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let started = false;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") { depth++; started = true; }
      else if (ch === ")") { depth--; }
    }
    if (started && depth <= 0) return i + 1;
  }
  return Math.min(startIdx + 50, lines.length);
}

/** Find the matching `END;` (with optional label) for a routine body. */
function findRoutineEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let sawBegin = false;
  let dollarDepth = 0;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    // PostgreSQL dollar-quoted body: $$ ... $$
    const dollars = (line.match(/\$\$/g) ?? []).length;
    if (dollars > 0) {
      dollarDepth += dollars;
      sawBegin = true;
      if (dollarDepth % 2 === 0) return i + 1;
    }
    if (/\bBEGIN\b/i.test(line) && !/\bEND\s+BEGIN\b/i.test(line)) {
      depth++;
      sawBegin = true;
    }
    if (/\bEND\b\s*;?/i.test(line) && sawBegin && dollarDepth === 0) {
      depth--;
      if (depth <= 0) return i + 1;
    }
  }
  // No BEGIN/END or $$ — fall back to a single-statement routine (ends at ;)
  if (!sawBegin) return findStatementEnd(lines, startIdx);
  return Math.min(startIdx + 200, lines.length);
}

/** Custom class extractor — handles CREATE TABLE / VIEW / INDEX / SEQUENCE / SCHEMA. */
export function extractSqlClasses(lines: string[], _fns: FunctionInfo[]): ClassInfo[] {
  const classes: ClassInfo[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip line comments / single-quoted noise
    if (/^\s*(--|#)/.test(line)) continue;

    // CREATE [GLOBAL TEMPORARY|TEMP|UNLOGGED] TABLE [IF NOT EXISTS] schema.name (
    // — the statement's head may run over lines (`CREATE TABLE⏎clubs (`, `CREATE⏎TABLE⏎IF NOT EXISTS clubs(`).
    let head = line;
    if (/^\s*CREATE\b[^(;]*$/i.test(line)) {
      for (let k = i + 1; k < Math.min(lines.length, i + 4) && !/[(;]/.test(head); k++) head = head.trimEnd() + " " + lines[k]!.trim();
      if (!/^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\b/i.test(head)) head = line;
    }
    const tableMatch = head.match(
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:GLOBAL\s+TEMPORARY\s+|TEMPORARY\s+|TEMP\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (tableMatch) {
      const fqName = unquoteName(tableMatch[1]!);
      const endLine = findParenEnd(lines, i);
      const body = lines.slice(i, endLine).join("\n");
      const properties: PropertyInfo[] = [];
      const implementsList: string[] = [];

      // Pull out column lines from inside the parens.
      const parenStart = body.indexOf("(");
      if (parenStart >= 0) {
        const inner = sliceBalanced(body, parenStart);
        for (const colLine of splitColumns(inner)) {
          const prop = parseColumnLine(colLine);
          if (prop) properties.push(prop);
          // FOREIGN KEY (col) REFERENCES other_table → record as "implements"
          const fk = colLine.match(/REFERENCES\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i);
          if (fk) {
            const target = unquoteName(fk[1]!);
            if (!implementsList.includes(target)) implementsList.push(target);
          }
        }
      }

      // INHERITS (parent_table) — PostgreSQL
      const inherits = body.match(/INHERITS\s*\(\s*([\w.]+)/i);
      const ext = inherits ? inherits[1] : null;

      classes.push({
        name: fqName,
        extends: ext,
        implements: implementsList,
        decorators: ["table"],
        methods: [],
        properties,
        isExported: true,
        line: i + 1,
        endLine,
      });
      continue;
    }

    // CREATE VIEW
    const viewMatch = line.match(
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (viewMatch) {
      const name = unquoteName(viewMatch[1]!);
      const endLine = findStatementEnd(lines, i);
      classes.push({
        name,
        extends: null,
        implements: extractViewTables(lines, i, endLine),
        decorators: /MATERIALIZED/i.test(line) ? ["materialized-view"] : ["view"],
        methods: [],
        properties: [],
        isExported: true,
        line: i + 1,
        endLine,
      });
      continue;
    }

    // CREATE INDEX
    const indexMatch = line.match(
      /^\s*CREATE\s+(?:UNIQUE\s+)?(?:CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)\s+ON\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (indexMatch) {
      const name = unquoteName(indexMatch[1]!);
      const onTable = unquoteName(indexMatch[2]!);
      const endLine = findStatementEnd(lines, i);
      classes.push({
        name,
        extends: onTable,
        implements: [],
        decorators: ["index"],
        methods: [],
        properties: [],
        isExported: true,
        line: i + 1,
        endLine,
      });
      continue;
    }

    // CREATE SEQUENCE
    const seqMatch = line.match(/^\s*CREATE\s+SEQUENCE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i);
    if (seqMatch) {
      const name = unquoteName(seqMatch[1]!);
      const endLine = findStatementEnd(lines, i);
      classes.push({
        name,
        extends: null,
        implements: [],
        decorators: ["sequence"],
        methods: [],
        properties: [],
        isExported: true,
        line: i + 1,
        endLine,
      });
      continue;
    }

    // CREATE SCHEMA
    const schemaMatch = line.match(/^\s*CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i);
    if (schemaMatch) {
      const name = unquoteName(schemaMatch[1]!);
      const endLine = findStatementEnd(lines, i);
      classes.push({
        name,
        extends: null,
        implements: [],
        decorators: ["schema"],
        methods: [],
        properties: [],
        isExported: true,
        line: i + 1,
        endLine,
      });
      continue;
    }

    // CREATE TYPE (composite / enum)
    const typeMatch = line.match(/^\s*CREATE\s+TYPE\s+([\w.]+)\s+AS\b/i);
    if (typeMatch) {
      const endLine = findStatementEnd(lines, i);
      classes.push({
        name: typeMatch[1],
        extends: null,
        implements: [],
        decorators: /AS\s+ENUM\b/i.test(line) ? ["enum"] : ["type"],
        methods: [],
        properties: [],
        isExported: true,
        line: i + 1,
        endLine,
      });
    }
  }

  return classes;
}

/** Slice balanced text starting at `start` (which must be a `(`). Returns inner text. */
function sliceBalanced(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

/** Split comma-separated column definitions, respecting nested parens. */
function splitColumns(text: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/** Find the end of a statement terminated by `;` (single line or multi). */
function findStatementEnd(lines: string[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    if (/;\s*$/.test(lines[i].trim())) return i + 1;
  }
  return Math.min(startIdx + 30, lines.length);
}

/** Pull table names referenced from a view body — for the data-model graph. */
function extractViewTables(lines: string[], startIdx: number, endIdx: number): string[] {
  const tables = new Set<string>();
  const body = lines.slice(startIdx, endIdx).join(" ");
  const re = /\b(?:FROM|JOIN)\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = unquoteName(m[1]!);
    tables.add(name);
  }
  return [...tables];
}

/**
 * The table a DML statement names, as the ER graph keys it: the last segment of
 * `schema.table`, unquoted. `dual` and a SQL keyword caught by a partial match
 * (`SELECT … FROM (subquery)` never reaches here) are not tables.
 */
function tableEntity(target: string, rest: string, local: ReadonlySet<string>): string | null {
  // System catalogs are not the application's tables.
  if (/^(?:information_schema|sys|mysql)\./i.test(target) || /^pg_/i.test(target)) return null;
  // `[dbo].[Orders]`, `"public"."person"`: the quoted first part was captured, the rest follows it.
  const parts = [...rest.matchAll(/\.(?:\[([^\]]+)\]|"([^"]+)"|`([^`]+)`|(\w+))/gy)].map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]!);
  const name = (parts.pop() ?? target.split(".").pop()!).replace(/^["`[]|["`\]]$/g, "");
  if (!/^[A-Za-z_]\w*$/.test(name)) return null;
  // `ON UPDATE CASCADE` wrapped onto its own line reads as an UPDATE statement.
  if (/^(?:dual|select|set|values|where|only|lateral|unnest|cascade|restrict|no)$/i.test(name)) return null;
  if (/^pg_/i.test(name) || local.has(name.toLowerCase())) return null;
  return name;
}

/**
 * Relations a file names but that are not tables: CTEs (`WITH q AS (`, `, deps AS (`),
 * a trigger's transition tables (`REFERENCING OLD TABLE AS old_rows`) and the views it creates.
 */
function localRelations(text: string): Set<string> {
  const out = new Set<string>();
  // `with "today" as (` — a query builder's dump quotes the names.
  for (const m of text.matchAll(/(?:\bWITH(?:\s+RECURSIVE)?|,)\s*["`[]?(\w+)["`\]]?\s*(?:\([^)]*\))?\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi)) out.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(/\b(?:OLD|NEW)\s+TABLE\s+AS\s+(\w+)/gi)) out.add(m[1]!.toLowerCase());
  // A view the file creates is its query, not a table of the data model.
  for (const m of text.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\w+\.)?"?(\w+)/gi)) out.add(m[1]!.toLowerCase());
  return out;
}

/** The statement starting at line `i`, up to its `;` (`findStatementEnd`), on one line, comments dropped. */
function statementText(lines: string[], i: number): string {
  return lines.slice(i, findStatementEnd(lines, i)).map((l) => l.replace(/--.*$/, "")).join(" ");
}

/** Pull DML statement targets — used by extractDataSources below. */
function extractDmlStatements(lines: string[]): DataSourceInfo[] {
  const sources: DataSourceInfo[] = [];
  const local = localRelations(lines.join("\n"));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(--|#)/.test(line)) continue;

    // SELECT ... FROM t / DELETE FROM t — a SELECT's FROM may sit on a later line of the statement.
    const isSelect = /^\s*SELECT\b/i.test(line);
    const selectText = isSelect && !/\bFROM\b/i.test(line) ? statementText(lines, i) : line;
    const selectMatch = (isSelect ? selectText.match(/^\s*SELECT\b[\s\S]*?\bFROM\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)(?![\w.]|\s*\()/i) : null)
      ?? line.match(/^\s*DELETE\s+FROM\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i);
    if (selectMatch) {
      const target = unquoteName(selectMatch[1]!);
      const verb = /^\s*DELETE/i.test(line) ? "DELETE" : "SELECT";
      const entity = tableEntity(target, selectText.slice(selectMatch.index! + selectMatch[0].length), local);
      sources.push({
        kind: "database",
        name: verb,
        target,
        ...(entity ? { entity } : {}),
        access: verb === "SELECT" ? "read" : "write",
        calls: [],
        line: i + 1,
      });
      continue;
    }

    // INSERT INTO t / UPDATE t / MERGE INTO t / REPLACE INTO t / TRUNCATE TABLE t
    const writeMatch = line.match(
      /^\s*(INSERT\s+INTO|UPDATE|MERGE\s+INTO|REPLACE\s+INTO|TRUNCATE\s+TABLE|TRUNCATE)\s+((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (writeMatch) {
      const verb = writeMatch[1]!.toUpperCase().replace(/\s+/g, " ");
      const target = unquoteName(writeMatch[2]!);
      const entity = tableEntity(target, line.slice(writeMatch.index! + writeMatch[0].length), local);
      sources.push({
        kind: "database",
        name: verb,
        target,
        ...(entity ? { entity } : {}),
        access: "write",
        calls: [],
        line: i + 1,
      });
      continue;
    }

    // EXEC / CALL stored_procedure(args).
    // Skip the leading `FUNCTION`/`PROCEDURE` keyword (used by `CREATE TRIGGER ... EXECUTE FUNCTION foo()`)
    // so the actual routine name lands in the target.
    // Dynamic SQL (`EXECUTE STATEMENT`, `EXECUTE IMMEDIATE`, `EXECUTE BLOCK`) names no routine.
    const execMatch = line.match(/^\s*(?:EXEC(?:UTE)?|CALL|PERFORM)\s+(?:FUNCTION\s+|PROCEDURE\s+)?([\w.$]+)/i);
    if (execMatch && !/^(?:STATEMENT|IMMEDIATE|BLOCK|AS|sp_executesql)$/i.test(execMatch[1]!)) {
      sources.push({
        kind: "database",
        name: "EXEC",
        target: execMatch[1],
        routine: true,
        calls: [],
        line: i + 1,
      });
      continue;
    }

    // GRANT / REVOKE privileges ON an object: the object is the target, never
    // the privilege (`GRANT SELECT ON players` named a table `SELECT`). A role
    // grant (`GRANT admin TO alice`) names no object and is no access.
    const grantMatch = line.match(
      /^\s*(GRANT|REVOKE)\b.*?\bON\s+(?:TABLE\s+|PROCEDURE\s+|FUNCTION\s+|SEQUENCE\s+|VIEW\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (/^\s*(?:GRANT|REVOKE)\b/i.test(line)) {
      if (grantMatch) {
        sources.push({
          kind: "database",
          name: grantMatch[1]!.toUpperCase(),
          target: unquoteName(grantMatch[2]!),
          calls: [],
          line: i + 1,
        });
      }
      continue;
    }

    // ALTER TABLE / DROP TABLE — DDL commands
    const ddlMatch = line.match(
      /^\s*(ALTER\s+TABLE|DROP\s+TABLE|DROP\s+VIEW|DROP\s+INDEX|RENAME\s+TABLE)\s+(?:IF\s+EXISTS\s+)?((?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[\w$]+))*)/i,
    );
    if (ddlMatch) {
      const verb = ddlMatch[1]!.toUpperCase().replace(/\s+/g, " ");
      const target = unquoteName(ddlMatch[2]!);
      sources.push({
        kind: "database",
        name: verb,
        target,
        calls: [],
        line: i + 1,
      });
    }
  }

  return sources;
}

export const sqlSpec: RegexLangSpec = {
  language: "sql",
  extensions: [".sql", ".ddl", ".dml", ".psql", ".mysql", ".tsql", ".plsql"],
  blockStyle: "brace", // overridden in custom extractors via findRoutineEnd/findParenEnd
  lineCommentPrefixes: ["--", "#"],

  functionPatterns: [
    // CREATE [OR REPLACE | OR ALTER] / RECREATE PROCEDURE / FUNCTION / TRIGGER
    // name — name is group 1. `OR ALTER` is Firebird's and SQL Server's spelling,
    // `RECREATE` Firebird's drop-and-create.
    // Optional surrounding quotes/brackets are stripped non-capturingly so the
    // generic extractor (which reads m[1] for the name) gets a clean identifier.
    {
      pattern: /^\s*(?:CREATE\s+(?:OR\s+(?:REPLACE|ALTER)\s+)?|RECREATE\s+)(?:PROCEDURE|FUNCTION|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`[]?([\w.]+)/i,
      isExported: () => true,
    },
  ],

  // We override class extraction entirely (tables, views, indexes, sequences, schemas, types).
  classPatterns: [],
  extractClasses: extractSqlClasses,

  parseParam: parseSqlParam,

  // SQL doesn't have imports, but we capture a few patterns that play the same role:
  importPatterns: [
    // USE database_name;
    {
      pattern: /^\s*USE\s+(?:\[([^\]]+)\]|"([^"]+)"|`([^`]+)`|([\w]+))\s*;?/i,
      getSource: (m) => m[1] ?? m[2] ?? m[3] ?? m[4]!,
      getSpecifiers: (m) => [m[1] ?? m[2] ?? m[3] ?? m[4]!],
    },
    // \i path/to/file.sql (psql include) / :r file.sql (sqlcmd)
    {
      pattern: /^\s*(?:\\i|:r)\s+([\S]+)/,
      getSource: (m) => m[1],
      getSpecifiers: () => [],
    },
    // IMPORT FOREIGN SCHEMA ... FROM SERVER server_name
    {
      pattern: /^\s*IMPORT\s+FOREIGN\s+SCHEMA\s+\S+(?:\s+FROM\s+SERVER\s+([\w]+))?/i,
      getSource: (m) => m[1] ?? "foreign-schema",
      getSpecifiers: () => [],
    },
  ],

  extractDataSources: (lines, _classes) => extractDmlStatements(lines),

  extractRoutes: (_lines, _classes): RouteInfo[] => [],

  // SQL routines (PROCEDURE/FUNCTION/TRIGGER) need BEGIN/END-aware end-line
  // patching so blast-radius and complexity see the right body range.
  // Named-query files (aiosql, HugSQL, sqlc …): each `-- name:` block is a function.
  postProcessFunctions: (lines, fns) => [...fixSqlFunctionEndLines(lines, fns), ...namedQueries(lines)],
};

/**
 * Override the default function extraction so routines pick up the right end
 * line and parameter list. The base regex-extractor produces names + params
 * from the default function loop; SQL bodies are delimited by `BEGIN`/`END`
 * (or `$$`), which the shared brace scanner cannot read at all, so both the
 * end line and the call list are patched here from `findRoutineEnd`.
 *
 * The calls MUST be recomputed rather than kept: the shared scanner sees a
 * `CREATE FUNCTION …` header that never opens a brace and correctly reports a
 * bodyless declaration, so the default call list for a SQL routine is empty.
 */
export function fixSqlFunctionEndLines(lines: string[], fns: FunctionInfo[]): FunctionInfo[] {
  return fns.map((fn) => {
    const idx = fn.line - 1;
    if (idx < 0 || idx >= lines.length) return fn;
    const endLine = findRoutineEnd(lines, idx);
    const calls = extractCallsFromBody(lines, idx + 1, endLine, ["--", "#"]);
    return { ...fn, endLine, calls };
  });
}

// Suppress unused-import warnings for types we re-export indirectly.
export type _SqlTypes = ImportInfo | ExportInfo | CallInfo;
