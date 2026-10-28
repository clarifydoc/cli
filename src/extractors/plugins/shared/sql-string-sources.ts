import type { DataSourceInfo } from "../../../types/analysis.js";
import { sqlVerbAccess } from "./db-access.js";

/**
 * SQL-in-string-literal data-source extraction for regex-path languages whose
 * DB layer embeds raw SQL in string constants — C++ QSqlQuery
 * (`query.prepare("UPDATE track_locations SET …")`), C sqlite3
 * (`sqlite3_exec(db, "SELECT …")`), Objective-C, etc.
 *
 * The scanner concatenates a statement across the language's adjacent string
 * literals, which routinely span lines:
 *
 *     query.prepare("UPDATE track_locations "
 *                   "SET fs_deleted=1 "
 *                   "WHERE directory=:directory");
 *
 * and preserves ALL-CAPS identifier tokens BETWEEN fragments, because table
 * names are often preprocessor constants spliced into the literal:
 *
 *     QStringLiteral("SELECT * FROM " CUE_TABLE " WHERE track_id=:id")
 *
 * Dropping the macro would make `WHERE` land in the table position; keeping it
 * yields `CUE_TABLE` — not the physical table name, but a stable, readable
 * datastore key that still groups every access to that table.
 *
 * Emits one `kind: "database"` DataSourceInfo per table a statement touches —
 * its own target first, then each table it joins or subqueries (`joined`) —
 * and one `EXEC` row per stored procedure it calls (`routine`). Statements
 * without a confident table are skipped rather than polluting the graph with
 * `(unresolved)` datastores.
 */

/**
 * `body` as the `"…"` literal `LINE_TOKEN_RE` reads back verbatim: backslashes
 * and quotes both escaped, so a `\` or `"` inside the text can neither end the
 * literal early nor swallow the quote that does.
 */
export function asDoubleQuotedLiteral(body: string): string {
  return `"${body.replace(/[\\"]/g, "\\$&")}"`;
}

/** A string literal's content, or an ALL-CAPS macro identifier between literals. */
const LINE_TOKEN_RE = /"((?:[^"\\]|\\.)*)"|\b([A-Z][A-Z0-9_]{2,})\b/g;

/**
 * Statement openers. `INSERT OR REPLACE INTO` (SQLite) folds into INSERT INTO, as do MySQL's
 * modifiers (`INSERT IGNORE INTO`, `UPDATE IGNORE t`, `DELETE LOW_PRIORITY FROM`): never a table.
 */
const SQL_START_RE =
  /\b(SELECT|INSERT\s+(?:OR\s+\w+\s+)?(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\s+)*INTO|UPDATE(?:\s+(?:LOW_PRIORITY|IGNORE)\b)*|DELETE\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\s+)*FROM|REPLACE\s+(?:(?:LOW_PRIORITY|DELAYED)\s+)?INTO|MERGE\s+INTO|TRUNCATE\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;
/** {@link SQL_START_RE} where the text starts. */
const SQL_START_AT_RE = new RegExp(`^${SQL_START_RE.source}`, "i");
/** MySQL's statement modifiers, dropped from the verb. */
const VERB_MODIFIER_RE = /\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\b/g;

/**
 * A table token: bracketed/quoted/backticked or a bare (possibly dotted) name.
 * A schema written before a quoted name (`"public"."Orders"`, `[dbo].[Users]`,
 * `public."Orders"`) is skipped, so the name is the table, not the schema. A
 * bare name may carry a `$` after its first character — Firebird's
 * `rdb$database`, Oracle's `v$session` — but never start with one, so a
 * template hole (`FROM ${table}`) is not a name.
 */
const TABLE = String.raw`(?:(?:\[[^\]]+\]|"[^"]+"|\x60[^\x60]+\x60|\w+)\.(?=[\["\x60]))?(?:\[([^\]]+)\]|"([^"]+)"|\x60([^\x60]+)\x60|([\w.]+(?:\$[\w.$]*)?))`;

/**
 * `FROM`/`JOIN` source. The trailing `(` capture distinguishes a TABLE from a
 * table-valued FUNCTION invoked in the same position — Firebird's selectable
 * stored procedures (`FROM SP_PLAYER_HISTORY(:ID, :MATCH_DATE)`, the backbone of many
 * Delphi apps), Postgres `FROM my_func(x)`, SQL Server TVFs. Those are callable
 * routines, not stored relations: they are recorded as a routine call
 * (`routine: true`), never as a table or an ER node. `USING` is PostgreSQL's
 * `DELETE … USING b` and `MERGE … USING b` source (a `JOIN … USING (id)`
 * names columns, never a table); `JOIN FETCH` is JPQL's, and `IS DISTINCT
 * FROM x` compares a value.
 */
const FROM_JOIN_RE = new RegExp(String.raw`(?<!\bDISTINCT\s+)\b(?:FROM|JOIN(?:\s+FETCH)?|USING)\s+${TABLE}\s*(\()?`, "gi");
/**
 * Further comma-joined sources after a FROM source and its alias —
 * `FROM PLAYER P, TEAM T WHERE …`, the pre-ANSI join style older code is
 * full of. An alias is any word that is not a clause keyword.
 */
const COMMA_SOURCE_RE = new RegExp(
  String.raw`^\s*(?:(?:AS\s+)?(?!(?:WHERE|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|NATURAL|ORDER|GROUP|ON|UNION|HAVING|LIMIT|FOR|INTO|SET|VALUES|PLAN|ROWS|FETCH|OFFSET)\b)\w+)?\s*,\s*${TABLE}\s*(\()?`,
  "i",
);
const WRITE_RE = new RegExp(
  String.raw`^(INSERT\s+(?:OR\s+\w+\s+)?(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|IGNORE)\s+)*INTO|UPDATE(?:\s+(?:LOW_PRIORITY|IGNORE)\b)*|DELETE\s+(?:(?:LOW_PRIORITY|QUICK|IGNORE)\s+)*FROM|REPLACE\s+(?:(?:LOW_PRIORITY|DELAYED)\s+)?INTO|MERGE\s+INTO|TRUNCATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${TABLE}`,
  "i",
);
const CREATE_DROP_RE = new RegExp(
  String.raw`^(CREATE\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${TABLE}`,
  "i",
);

/**
 * A stored-procedure call as the statement itself: Firebird `EXECUTE PROCEDURE
 * NAME(…)` (anywhere — the phrase is unambiguous), JDBC/ODBC `{call name(?)}`
 * and `CALL name(…)` at the start, and T-SQL `EXEC name @p` at the start.
 */
const EXECUTE_PROCEDURE_RE = new RegExp(String.raw`\bEXECUTE\s+PROCEDURE\s+${TABLE}`, "i");
const CALL_RE = new RegExp(String.raw`^\s*\{?\s*CALL\s+${TABLE}\s*\(`, "i");
const EXEC_RE = new RegExp(
  String.raw`^\s*EXEC(?:UTE)?\s+(?!(?:IMMEDIATE|BLOCK|STATEMENT|AS|sp_executesql)\b)(?:@\w+\s*=\s*)?${TABLE}`,
  "i",
);

/**
 * Names in a routine's position that are SQL built-ins, not routines the
 * application declares: set-returning functions and the keywords a `FROM x(`
 * shape also matches (`LATERAL (`, `VALUES (`, Oracle `TABLE(`).
 */
const BUILTIN_SOURCES = new Set([
  "GENERATE_SERIES", "UNNEST", "JSON_EACH", "JSONB_EACH", "JSON_ARRAY_ELEMENTS", "JSONB_ARRAY_ELEMENTS",
  "JSON_TO_RECORDSET", "JSONB_TO_RECORDSET", "JSON_POPULATE_RECORDSET", "JSONB_POPULATE_RECORDSET",
  "JSON_TABLE", "XMLTABLE", "OPENJSON", "OPENROWSET", "OPENQUERY", "OPENXML", "OPENDATASOURCE",
  "STRING_SPLIT", "REGEXP_SPLIT_TO_TABLE", "TABLE", "LATERAL", "VALUES", "ONLY", "FLATTEN",
  "READ_CSV", "READ_CSV_AUTO", "READ_PARQUET", "READ_JSON", "PRAGMA_TABLE_INFO",
]);

/**
 * The engine's own catalogue — Firebird `RDB$`/`MON$`/`SEC$`, Oracle `V$`/`GV$`
 * views, SQLite's `sqlite_master`, the standard `information_schema` and
 * PostgreSQL's `pg_catalog` (its `pg_` relations also unqualified: `pg_class`, `pg_roles`).
 */
const SYSTEM_RELATION_RE = /^(?:(?:RDB|MON|SEC|G?V)\$|sqlite_(?:master|schema|sequence|temp_master|stat\d)$|pragma_\w+$|(?:information_schema|pg_catalog|performance_schema|mysql|sys|master|msdb)\.|pg_\w+$)/i;
/** A quoted name in an engine catalogue schema (`INFORMATION_SCHEMA.\`EVENTS\``), unquoted so the schema stays with it. */
const SYSTEM_QUALIFIED_RE = /\b(information_schema|pg_catalog|performance_schema|mysql|sys|master|msdb)\s*\.\s*(?:\x60([^\x60]+)\x60|"([^"]+)"|\[([^\]]+)\])/gi;

/**
 * A migration tool's bookkeeping table — what has been applied, not the
 * application's data: Alembic, Flyway, Rails, Entity Framework, Knex,
 * Sequelize, Prisma, Doctrine, Liquibase. A schema may qualify it.
 */
const BOOKKEEPING_TABLE_RE = /^(?:[\w"`[\]]+\.)?["`[]?(?:alembic_version|flyway_schema_history|schema_migrations|ar_internal_metadata|__EFMigrationsHistory|knex_migrations(?:_lock)?|SequelizeMeta|_prisma_migrations|doctrine_migration_versions|databasechangelog(?:lock)?)["`\]]?$/i;

/** SQL keywords that must never be read as a table name — macro-splice fallout,
 *  and backtracking artifacts (`CREATE TABLE IF NOT EXISTS " + tableName` leaves
 *  a bare `IF` in the table slot when the name is a runtime variable). */
const NOT_A_TABLE = new Set([
  "WHERE", "SET", "VALUES", "SELECT", "ORDER", "GROUP", "ON", "AS", "AND", "OR",
  "IF", "NOT", "EXISTS", "INTO", "TABLE",
  // `CROSS JOIN LATERAL …`, `ALTER TABLE ${t} AUTO_INCREMENT = 1`: clause words after a hole.
  "LATERAL", "AUTO_INCREMENT",
  // Oracle's one-row dummy relation (`SELECT SYSDATE FROM dual`).
  "DUAL",
  // English articles/determiners — UI prose like "Select controls from a list"
  // reads as SELECT…FROM otherwise. Real tables are never these words.
  "A", "AN", "THE", "ALL", "ANY", "YOUR", "THIS", "THESE", "ONE", "EACH",
]);

/**
 * `ORDER` and `GROUP` are keywords, but `Order` and `Group` are among the most
 * common entity names, and JPQL/HQL (`SELECT o FROM Order o`) spell the entity
 * exactly so. A keyword is never written in that capitalization; prose words
 * (`The`, `Your`) get no such pass.
 */
const ENTITY_SPELLING = new Set(["Order", "Group"]);

function notATable(t: string): boolean {
  return NOT_A_TABLE.has(t.toUpperCase()) && !ENTITY_SPELLING.has(t);
}

interface PendingStatement {
  text: string;
  line: number;
}

/** Quoted-string contents + macro tokens on a line, joined with spaces. */
function tokenStream(line: string): { text: string; hasString: boolean } {
  const parts: string[] = [];
  let hasString = false;
  let end = 0;
  // A qualified name spliced from quoted parts (`FROM '+Quote('league')+'.'+Quote('clubs')`)
  // stays one name; after a `'.'` followed by a value no literal states (`Quote(Table)`), the
  // dot stays on the schema — a name still to come.
  let glue = false;
  for (const m of line.matchAll(LINE_TOKEN_RE)) {
    const gap = line.slice(end, m.index);
    end = m.index! + m[0].length;
    if (m[1] !== undefined) {
      hasString = true;
      if (m[1] === "." && parts.length > 0) {
        parts[parts.length - 1] += ".";
        glue = true;
        continue;
      }
      if (glue && parts.length > 0 && !HOLE_IN_GAP_RE.test(gap)) parts[parts.length - 1] += m[1];
      else parts.push(m[1]);
      glue = false;
    } else if (hasString || parts.length === 0) {
      // Macro tokens count only once a string fragment is in play on this line
      // or as the very first token (`PLAYLIST_TRACKS_TABLE` after `from `).
      parts.push(m[2]!);
      glue = false;
    }
  }
  return { text: parts.join(" "), hasString };
}

/** A value between two literals: a name that is no callee (`Table` in `+ Quote(Table) +`). */
const HOLE_IN_GAP_RE = /[A-Za-z_][\w.]*(?![\w.]*\s*\()/;

/** True when the raw line ends its surrounding statement (a `;` outside strings). */
function endsStatement(line: string): boolean {
  return /;/.test(line.replace(/"(?:[^"\\]|\\.)*"/g, ""));
}

/** One table or routine a statement touches. */
export interface SqlStatementAccess {
  /** `SELECT`, `INSERT INTO`, `UPDATE`, … — `EXEC` for a routine call. */
  verb: string;
  /** The table, or the routine when `routine` is set. */
  table: string;
  /** The target is a stored procedure / table-valued function the statement calls. */
  routine?: true;
  /**
   * A further source the statement reads beside its main one — a JOINed table,
   * a subquery's table, the source of an `INSERT … SELECT`. The first access is
   * the statement's own; consumers asking "which table is this query about"
   * read that one and skip these.
   */
  joined?: true;
}

/**
 * For each position of `sql`, whether a `FROM` there names a source of the
 * statement: at the top level, or directly inside a subquery's parentheses.
 * `EXTRACT(YEAR FROM created)` and `SUBSTRING(x FROM 2)` are function
 * arguments, and their `FROM` names a column; text inside a quoted literal
 * (`WHERE note = 'moved from Lyon'`) is no SQL at all. Also the paren depth,
 * so the statement's own top-level FROM is told from a subquery's.
 */
function sourceScopes(sql: string): { inScope: (i: number) => boolean; depthAt: (i: number) => number } {
  const scope = new Uint8Array(sql.length);
  const depth = new Uint16Array(sql.length);
  const stack: boolean[] = [];
  let inQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inQuote) {
      if (ch === "'") inQuote = false;
      depth[i] = stack.length;
      continue;
    } else if (ch === "'") {
      inQuote = true;
      depth[i] = stack.length;
      continue;
    } else if (ch === "(") {
      // The subquery may open lines below its `(` (`VALUES ((⏎            SELECT id`).
      stack.push(/^\(\s*(?:SELECT|WITH)\b/i.test(sql.slice(i, i + 80)));
    } else if (ch === ")") {
      stack.pop();
    }
    scope[i] = stack.length === 0 || stack[stack.length - 1] ? 1 : 0;
    depth[i] = stack.length;
  }
  return { inScope: (i) => scope[i] === 1, depthAt: (i) => depth[i] ?? 0 };
}

/** Names a `WITH x AS (…)` clause defines: the statement's own, not tables. */
function cteNames(stmt: string): Set<string> {
  const out = new Set<string>();
  if (!/\bWITH\b/i.test(stmt)) return out;
  for (const m of stmt.matchAll(/(?:\bWITH(?:\s+RECURSIVE)?|,)\s*["`[]?(\w+)["`\]]?\s*(?:\([^)]*\))?\s+AS\s*(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi)) out.add(m[1]!.toUpperCase());
  return out;
}

/** A routine name, or null when the name is a built-in or a stoplisted word. */
/** SQL's own scalar and aggregate functions: never a routine of the schema. */
const SQL_FUNCTIONS = new Set([
  "COALESCE", "NULLIF", "IFNULL", "ISNULL", "NVL", "NVL2", "CAST", "CONVERT", "GREATEST", "LEAST",
  "SUM", "COUNT", "MAX", "MIN", "AVG", "CONCAT", "LOWER", "UPPER", "SUBSTRING", "SUBSTR", "TRIM", "LENGTH", "ROUND", "ABS",
  "NOW", "DATE", "EXTRACT", "IF", "IIF", "CASE", "EXISTS", "ANY", "ALL", "SOME",
]);

function routineName(name: string | undefined): string | null {
  if (!name || notATable(name) || BUILTIN_SOURCES.has(name.toUpperCase()) || SQL_FUNCTIONS.has(name.toUpperCase())) return null;
  return /^[A-Za-z_][\w.$]*$/.test(name) ? name : null;
}

/** A table name, or null when it is a keyword, a CTE or the engine's catalogue. */
function tableName(name: string | undefined, ctes: Set<string>): string | null {
  if (!name || notATable(name) || ctes.has(name.toUpperCase())) return null;
  if (SYSTEM_RELATION_RE.test(name) || BOOKKEEPING_TABLE_RE.test(name)) return null;
  // `FROM league.{table}`: the schema is written, the name is a hole.
  if (name.endsWith(".")) return null;
  // `fmt.Sprintf("DELETE FROM %s", table)`, `"new_%s_new"`: a format verb is a hole, never a name.
  if (/%[-+# 0-9.]*[sdvqTxX]/.test(name)) return null;
  return name;
}

const captured = (m: RegExpMatchArray): string | undefined => m[1] ?? m[2] ?? m[3] ?? m[4];

/** A stored-procedure call the statement IS (`EXECUTE PROCEDURE x`, `CALL x(…)`, `EXEC x @a`), or null. */
function procedureCall(stmt: string): string | null {
  const firebird = stmt.match(EXECUTE_PROCEDURE_RE);
  if (firebird) return routineName(captured(firebird));
  const call = stmt.match(CALL_RE);
  if (call) return routineName(captured(call));
  const exec = stmt.match(EXEC_RE);
  if (!exec) return null;
  const name = captured(exec);
  // Prose opens with "Execute" too ("Execute command"): a bare word is a routine
  // only when it is spelled like one (qualified, bracketed, `_`) or takes arguments.
  const rest = stmt.slice(exec.index! + exec[0].length);
  const spelled = exec[0].includes("[") || /[._$]/.test(name ?? "") || /^\s*[(@:?]/.test(rest);
  return spelled ? routineName(name) : null;
}

/**
 * The stored routine a command runs: the statement's own `EXEC x` / `CALL x(…)`
 * / `{call x(?)}`, or — when the caller says the command is a stored procedure
 * (`CommandType.StoredProcedure`, `callproc`, `withProcedureName`) — its text
 * when that is a bare name (`dbo.usp_SignPlayer`, `[dbo].[usp_SignPlayer]`).
 * Null for anything else.
 */
export function routineCalled(text: string, storedProcedure = false): string | null {
  if (storedProcedure) {
    const bare = /^\s*((?:\[[^\]]+\]|"[^"]+"|\w+)(?:\.(?:\[[^\]]+\]|"[^"]+"|\w+))*)\s*;?\s*$/.exec(text);
    if (bare) return routineName(bare[1]!.replace(/[[\]"]/g, ""));
  }
  return procedureCall(text);
}

/** True when `text` opens a statement the scanner reads. */
function opensStatement(text: string): boolean {
  return SQL_START_RE.test(text) || CTE_START_RE.test(text) || procedureCall(text) !== null;
}

/** A statement opening with its CTEs, its SELECT on a later line (`'WITH ndx AS (' + …`). */
const CTE_START_RE = /^\s*WITH(?:\s+RECURSIVE)?\s+["\x60[]?\w+["\x60\]]?\s*(?:\([^)]*\))?\s+AS\s*\(/i;

/** Clause words that can follow a source where an alias would. */
const CLAUSE_WORD_RE = /^(?:WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|NATURAL|ORDER|GROUP|ON|UNION|HAVING|LIMIT|FOR|INTO|SET|VALUES|PLAN|ROWS|FETCH|OFFSET|USING|WITH|WINDOW|EXCEPT|INTERSECT|RETURNING|STRAIGHT_JOIN|APPLY|AND|OR|WHEN|THEN|AS|FROM)$/i;

/**
 * `alias → source` for each `FROM t a` / `JOIN t AS a` the statement writes
 * (lower-cased alias). Never after a comma: a select list's `, x.league league`
 * aliases a column.
 */
function sourceAliases(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of sql.matchAll(new RegExp(String.raw`\b(?:FROM|JOIN|USING)\s+${TABLE}\s+(?:AS\s+)?([A-Za-z_]\w*)`, "gi"))) {
    const alias = m[5]!;
    const name = captured(m);
    if (name && !CLAUSE_WORD_RE.test(alias)) out.set(alias.toLowerCase(), name);
  }
  return out;
}

/**
 * The statement's opening verb and where it starts. A statement whose CTEs
 * open it (`WITH x AS (SELECT …) UPDATE t SET …`) is the write that follows
 * them, at the top level; a CTE list ending in a SELECT keeps the first SELECT,
 * so its own table stays the first one a CTE body reads.
 */
function statementStart(stmt: string): RegExpMatchArray | null {
  const first = stmt.match(SQL_START_RE);
  const cte = /^\s*\(?\s*WITH\b/i.exec(stmt);
  if (!first || !cte || first[1]!.toUpperCase() !== "SELECT") return first;
  let depth = 0;
  let inQuote = false;
  for (let i = cte.index + cte[0].length; i < stmt.length; i++) {
    const ch = stmt[i]!;
    if (inQuote) inQuote = ch !== "'";
    else if (ch === "'") inQuote = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && /[A-Za-z]/.test(ch) && !/\w/.test(stmt[i - 1] ?? "")) {
      const m = stmt.slice(i, i + 40).match(SQL_START_AT_RE);
      if (m) return m[1]!.toUpperCase() === "SELECT" ? first : Object.assign(m, { index: i });
    }
  }
  return first;
}

/**
 * Every table and routine a statement touches, the statement's own target
 * first: the written table of a write, the top-level FROM source of a SELECT.
 * Then each further source it reads (JOINs, comma joins, subqueries) as a
 * `joined` SELECT. A `FROM name(` source is a routine call (`EXEC`, `routine`).
 * Empty when the text is not SQL with a target.
 */
export function statementAccesses(raw: string): SqlStatementAccess[] {
  const stmt = raw.replace(SYSTEM_QUALIFIED_RE, (_, schema: string, a?: string, b?: string, c?: string) => `${schema}.${a ?? b ?? c}`);
  const proc = procedureCall(stmt);
  if (proc) return [{ verb: "EXEC", table: proc, routine: true }];
  const start = statementStart(stmt);
  if (!start) return [];
  const sql = stmt.slice(start.index!);
  // A write after CTEs reads what their bodies read: the sources are scanned from the `WITH`.
  const sourceSql = start.index! > 0 && /^\s*\(?\s*WITH\b/i.test(stmt) && !/^SELECT/i.test(start[1]!) ? stmt.slice(stmt.search(/\bWITH\b/i)) : sql;
  const verb = start[1]!.toUpperCase().replace(VERB_MODIFIER_RE, "").replace(/\s+/g, " ");
  const ctes = cteNames(stmt);
  let aliasMap: Map<string, string> | undefined;
  const aliases = (): Map<string, string> => (aliasMap ??= sourceAliases(sourceSql));

  const out: SqlStatementAccess[] = [];
  const seen = new Set<string>();
  const add = (access: SqlStatementAccess): void => {
    const key = `${access.routine ? "r" : "t"}:${access.table.toUpperCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(access);
  };

  if (verb !== "SELECT") {
    if (verb.startsWith("UPDATE") && !/\bSET\b/i.test(sql)) {
      // Prose like "Update available for download" is not SQL.
      return [];
    }
    const m = sql.match(WRITE_RE) ?? sql.match(CREATE_DROP_RE);
    let written = m ? m[2] ?? m[3] ?? m[4] ?? m[5] : undefined;
    // `UPDATE c SET … FROM clubs c` (T-SQL, also through a JOIN): the alias names the table its source gives it.
    if (written && verb.startsWith("UPDATE") && /^\w+$/.test(written)) written = aliases().get(written.toLowerCase()) ?? written;
    const table = tableName(written, ctes);
    if (!table) return [];
    add({ verb: verb.startsWith("INSERT") ? "INSERT INTO" : verb, table });
  }

  // FROM/JOIN sources, in scope only (never a function argument's FROM). For a
  // SELECT the first top-level one is the statement's own source; the rest,
  // and every source of a write, are reads beside it.
  const { inScope, depthAt } = sourceScopes(sourceSql);
  const sources: Array<{ name: string; routine: boolean; top: boolean }> = [];
  const hasWhere = /\bWHERE\b/i.test(sourceSql);
  // `USING b` is a source only of a DELETE or MERGE (`ALTER … TYPE int USING c::int` converts a column).
  const usingSources = /^(?:DELETE|MERGE)/.test(verb);
  FROM_JOIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FROM_JOIN_RE.exec(sourceSql)) !== null) {
    if (!inScope(m.index)) continue;
    if (/^USING/i.test(m[0]) && !usingSources) continue;
    const top = depthAt(m.index) === 0;
    sources.push({ name: captured(m) ?? "", routine: m[5] !== undefined, top });
    if (m[5] !== undefined || !hasWhere || !/^(?:FROM|USING)/i.test(m[0])) continue;
    // `FROM a x, b y WHERE …` — only where a WHERE follows, so UI prose
    // ("Select friends from Facebook, Twitter") gains nothing.
    let rest = sourceSql.slice(m.index + m[0].length);
    let more: RegExpMatchArray | null;
    while ((more = rest.match(COMMA_SOURCE_RE)) !== null) {
      sources.push({ name: captured(more) ?? "", routine: more[5] !== undefined, top });
      rest = rest.slice(more[0].length);
      if (more[5] !== undefined) break;
    }
  }
  // JPQL/HQL joins a path (`JOIN c.players p`, `JOIN FETCH c.league`): the part before the dot is an alias, never a schema.
  const isPath = (name: string): boolean => {
    const dot = name.indexOf(".");
    return dot > 0 && aliases().has(name.slice(0, dot).toLowerCase());
  };
  const resolved = sources
    .map((src) => ({ ...src, name: src.routine ? routineName(src.name) : isPath(src.name) ? null : tableName(src.name, ctes) }))
    .filter((src): src is { name: string; routine: boolean; top: boolean } => src.name !== null);
  if (verb === "SELECT") {
    const own = resolved.find((src) => src.top) ?? resolved[0];
    if (!own) return [];
    add(own.routine ? { verb: "EXEC", table: own.name, routine: true } : { verb, table: own.name });
    resolved.splice(resolved.indexOf(own), 1);
  }
  for (const src of resolved) {
    add(src.routine
      ? { verb: "EXEC", table: src.name, routine: true, joined: true }
      : { verb: "SELECT", table: src.name, joined: true });
  }
  return out;
}

/**
 * The statement's verb and the table it reads or writes, or null when the
 * text is not SQL with a table (also used by plugins that resolve a query's
 * text from a call argument rather than scanning every literal). A SELECT
 * whose own source is a routine answers with the first table it joins.
 */
export function tableFrom(stmt: string): { verb: string; table: string } | null {
  const accesses = statementAccesses(stmt);
  const first = accesses[0];
  if (!first) return null;
  if (!first.routine) return { verb: first.verb, table: first.table };
  if (procedureCall(stmt)) return null;
  const table = accesses.find((x) => !x.routine);
  return table ? { verb: "SELECT", table: table.table } : null;
}

/**
 * The `database` row of one access a statement makes, named `name` (its verb,
 * or the call that runs it). A routine names no entity; a table is its own
 * entity (that is what joins raw SQL to the ER model and attributes it to the
 * containing function) and carries the access its verb implies — DDL none.
 */
export function sqlAccessRow(hit: SqlStatementAccess, name: string, line: number): DataSourceInfo {
  const access = hit.routine ? undefined : sqlVerbAccess(hit.verb);
  return {
    kind: "database",
    name,
    target: hit.table,
    ...(hit.routine ? { routine: true as const } : {}),
    ...(access ? { access } : {}),
    ...(hit.routine ? {} : { entity: hit.table }),
    ...(hit.joined ? { joined: true as const } : {}),
    calls: [],
    line,
  };
}

/**
 * The tables a statement reads beside the one its caller already recorded as
 * the statement's own (`own`, compared by last part): JOINed and comma-joined
 * sources, subqueries and CTE bodies, the source of an `INSERT … SELECT`, an
 * `UPDATE … FROM` or a `DELETE … USING` — each a `joined` read named `name`,
 * one per table. For a plugin whose own row for the call carries more than the
 * table (the call's name, its filter fields, a table held in a constant); a
 * routine the statement also runs is left to that row. `lastPart` drops a
 * schema (`league.clubs` → `clubs`), as the caller's own row does; `keep`
 * vetoes a name the caller knows is no table (a hole it substituted).
 */
export function joinedTableRows(
  sql: string,
  own: string | null | undefined,
  name: string,
  line: number,
  opts: { lastPart?: boolean; keep?: (table: string) => boolean } = {},
): DataSourceInfo[] {
  const leaf = (t: string): string => t.split(".").pop()!;
  const seen = new Set(own ? [leaf(own).toLowerCase()] : []);
  const out: DataSourceInfo[] = [];
  for (const hit of statementAccesses(sql)) {
    if (hit.routine || (opts.keep && !opts.keep(hit.table))) continue;
    const table = opts.lastPart ? leaf(hit.table) : hit.table;
    if (seen.has(leaf(table).toLowerCase())) continue;
    seen.add(leaf(table).toLowerCase());
    out.push(sqlAccessRow({ verb: "SELECT", table, joined: true }, name, line));
  }
  return out;
}

/** Extract raw-SQL database accesses from string literals. See file header. */
export function extractSqlStringDataSources(lines: string[]): DataSourceInfo[] {
  const sources: DataSourceInfo[] = [];
  let pending: PendingStatement | null = null;

  const finalize = () => {
    if (!pending) return;
    // A stored procedure is a real access but no relation: it names no ER node,
    // and the trace shows it by name (`routine`).
    for (const hit of statementAccesses(pending.text)) sources.push(sqlAccessRow(hit, hit.routine ? "EXEC" : hit.verb, pending.line));
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;

    const { text, hasString } = tokenStream(line);

    if (pending) {
      if (!hasString) {
        finalize();
      } else {
        pending.text += " " + text;
        if (endsStatement(line)) finalize();
        continue;
      }
    }

    if (!pending && hasString && opensStatement(text)) {
      pending = { text, line: i + 1 };
      if (endsStatement(line)) finalize();
    }
  }
  finalize();
  return sources;
}
