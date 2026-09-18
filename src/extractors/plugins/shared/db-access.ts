/**
 * Read/write classification for database calls.
 *
 * `DataSourceInfo.access` is the field that answers "which endpoints MODIFY
 * this table?" — it drives `db-read` versus `db-write` in the dataflow-lite
 * reach, the `writesState` flag on a file's responsibility profile, and the
 * MCP `effect=db-write` filter. It was set by the JavaScript and Ruby plugins
 * only, so on every other language a write looked exactly like a read: a C#
 * `Add` + `SaveChangesAsync`, a Go `INSERT INTO`, a Python `session.add` all
 * reported `readsState: true, writesState: false`.
 *
 * Each plugin owns its verb table (core never inspects method names); this
 * module only holds the lookup and the SQL verb mapping every plugin shares.
 *
 * Deliberately EXACT leaf matching, never wildcards. A pattern language like
 * `*.get*` → read misfires on `forget`, `getOrCreate`, `res.send` and
 * `Set.delete`; an explicit set is the same size to write and cannot surprise.
 */

export interface DbVerbTable {
  /** Leaf names that read state. */
  read: ReadonlySet<string>;
  /** Leaf names that modify state. */
  write: ReadonlySet<string>;
}

/**
 * Classify one call leaf. Returns undefined when the table does not name it —
 * an honest "unclassified", which is NOT the same as a read. Fluent-chain
 * composition (`Where`, `Select`, `Include`) must land here: it neither reads
 * nor writes on its own, and calling it a read would attribute an access to
 * the wrong line.
 */
export function dbAccessFor(leaf: string, table: DbVerbTable): "read" | "write" | undefined {
  if (table.write.has(leaf)) return "write";
  if (table.read.has(leaf)) return "read";
  return undefined;
}

/**
 * Classify by the leading verb of a SQL statement. DDL stays unclassified on
 * purpose: a startup `CREATE TABLE IF NOT EXISTS` is not an answer to "who
 * modifies Orders", and counting it as a write would make every schema
 * bootstrap look like application behaviour.
 */
export function sqlVerbAccess(verb: string): "read" | "write" | undefined {
  const head = verb.trim().toUpperCase().split(/\s+/)[0] ?? "";
  switch (head) {
    case "SELECT":
      return "read";
    case "INSERT":
    case "UPDATE":
    case "DELETE":
    case "REPLACE":
    case "MERGE":
    case "UPSERT":
    case "TRUNCATE":
      return "write";
    default:
      return undefined; // CREATE / DROP / ALTER / GRANT / anything unrecognised
  }
}

/**
 * Build a table, asserting the two sets are disjoint. A leaf in both would
 * silently resolve as a write and hide the mistake, so fail at module load.
 */
export function dbVerbTable(read: readonly string[], write: readonly string[]): DbVerbTable {
  const readSet = new Set(read);
  const writeSet = new Set(write);
  for (const w of writeSet) {
    if (readSet.has(w)) {
      throw new Error(`db-access: "${w}" is listed as both read and write`);
    }
  }
  return { read: readSet, write: writeSet };
}
