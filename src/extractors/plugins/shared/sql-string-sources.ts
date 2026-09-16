import type { DataSourceInfo } from "../../../types/analysis.js";

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
 * Emits one `kind: "database"` DataSourceInfo per statement whose target table
 * resolves; statements without a confident table are skipped rather than
 * polluting the graph with `(unresolved)` datastores.
 */

/** A string literal's content, or an ALL-CAPS macro identifier between literals. */
const LINE_TOKEN_RE = /"((?:[^"\\]|\\.)*)"|\b([A-Z][A-Z0-9_]{2,})\b/g;

/** Statement openers. `INSERT OR REPLACE INTO` (SQLite) folds into INSERT INTO. */
const SQL_START_RE =
  /\b(SELECT|INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|MERGE\s+INTO|TRUNCATE\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\b/i;

/** A table token: bracketed/quoted/backticked or a bare (possibly dotted) name. */
const TABLE = String.raw`(?:\[([^\]]+)\]|"([^"]+)"|\x60([^\x60]+)\x60|([\w.]+))`;

/**
 * `FROM`/`JOIN` source. The trailing `(` capture distinguishes a TABLE from a
 * table-valued FUNCTION invoked in the same position — Firebird's selectable
 * stored procedures (`FROM SP_ELEV_HISTORIK(:ID, :DATO)`, the backbone of many
 * Delphi apps), Postgres `FROM generate_series(1,10)` / `FROM my_func(x)`,
 * SQL Server TVFs. Those are callable routines, not stored relations, so
 * recording them as tables invents datastores and ER nodes that no schema has.
 */
const FROM_JOIN_RE = new RegExp(String.raw`\b(?:FROM|JOIN)\s+${TABLE}\s*(\()?`, "gi");
const WRITE_RE = new RegExp(
  String.raw`^(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|MERGE\s+INTO|TRUNCATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${TABLE}`,
  "i",
);
const CREATE_DROP_RE = new RegExp(
  String.raw`^(CREATE\s+TABLE|DROP\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${TABLE}`,
  "i",
);

/** SQL keywords that must never be read as a table name — macro-splice fallout,
 *  and backtracking artifacts (`CREATE TABLE IF NOT EXISTS " + tableName` leaves
 *  a bare `IF` in the table slot when the name is a runtime variable). */
const NOT_A_TABLE = new Set([
  "WHERE", "SET", "VALUES", "SELECT", "ORDER", "GROUP", "ON", "AS", "AND", "OR",
  "IF", "NOT", "EXISTS", "INTO", "TABLE",
  // English articles/determiners — UI prose like "Select controls from a list"
  // reads as SELECT…FROM otherwise. Real tables are never these words.
  "A", "AN", "THE", "ALL", "ANY", "YOUR", "THIS", "THESE", "ONE", "EACH",
]);

interface PendingStatement {
  text: string;
  line: number;
}

/** Quoted-string contents + macro tokens on a line, joined with spaces. */
function tokenStream(line: string): { text: string; hasString: boolean } {
  const parts: string[] = [];
  let hasString = false;
  for (const m of line.matchAll(LINE_TOKEN_RE)) {
    if (m[1] !== undefined) {
      parts.push(m[1]);
      hasString = true;
    } else if (hasString || parts.length === 0) {
      // Macro tokens count only once a string fragment is in play on this line
      // or as the very first token (`PLAYLIST_TRACKS_TABLE` after `from `).
      parts.push(m[2]!);
    }
  }
  return { text: parts.join(" "), hasString };
}

/** True when the raw line ends its surrounding statement (a `;` outside strings). */
function endsStatement(line: string): boolean {
  return /;/.test(line.replace(/"(?:[^"\\]|\\.)*"/g, ""));
}

function tableFrom(stmt: string): { verb: string; table: string } | null {
  const start = stmt.match(SQL_START_RE);
  if (!start) return null;
  const sql = stmt.slice(start.index!);
  const verb = start[1]!.toUpperCase().replace(/\s+/g, " ");

  const pick = (m: RegExpMatchArray | null): string | null => {
    const t = m ? (m[2] ?? m[3] ?? m[4] ?? m[5] ?? null) : null;
    return t && !NOT_A_TABLE.has(t.toUpperCase()) ? t : null;
  };

  if (verb === "SELECT") {
    // SELECT needs a FROM/JOIN table; skip subqueries (`FROM (`).
    FROM_JOIN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_JOIN_RE.exec(sql)) !== null) {
      if (m[5]) continue; // `NAME(` — a table-valued function, not a table
      const t = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (t && !NOT_A_TABLE.has(t.toUpperCase())) return { verb, table: t };
    }
    return null;
  }
  if (verb.startsWith("UPDATE") && !/\bSET\b/i.test(sql)) {
    // Prose like "Update available for download" is not SQL.
    return null;
  }
  const table = pick(sql.match(WRITE_RE)) ?? pick(sql.match(CREATE_DROP_RE));
  if (!table) return null;
  return { verb: verb.startsWith("INSERT") ? "INSERT INTO" : verb, table };
}

/** Extract raw-SQL database accesses from string literals. See file header. */
export function extractSqlStringDataSources(lines: string[]): DataSourceInfo[] {
  const sources: DataSourceInfo[] = [];
  let pending: PendingStatement | null = null;

  const finalize = () => {
    if (!pending) return;
    const hit = tableFrom(pending.text);
    if (hit) {
      sources.push({
        kind: "database",
        name: hit.verb,
        target: hit.table,
        // The table IS the entity for raw SQL — this is what joins the access
        // to the ER model (synthesizeReferencedTableEntities) and attributes
        // it to the containing function (attributeDataAccessToSymbols).
        entity: hit.table,
        calls: [],
        line: pending.line,
      });
    }
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

    if (!pending && hasString && SQL_START_RE.test(text)) {
      pending = { text, line: i + 1 };
      if (endsStatement(line)) finalize();
    }
  }
  finalize();
  return sources;
}
