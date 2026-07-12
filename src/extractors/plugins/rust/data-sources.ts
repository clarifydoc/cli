import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/**
 * Rust data sources — sqlx/raw SQL, Diesel tables, reqwest HTTP calls, env
 * reads and lapin (AMQP) queues. Rust previously had no data-source
 * extraction at all.
 *
 * Raw SQL rides the shared SQL-in-strings scanner. Rust's multi-line SQL
 * usually sits in `r#"..."#` (or `r"..."`) raw strings — {@link normalizeRawStrings}
 * rewrites each raw-string span into per-line double-quoted fragments so the
 * scanner's adjacent-literal concatenation picks the statement up whole.
 */

/** Rewrite `r#"..."#` / `r"..."` raw strings into per-line `"..."` fragments. */
export function normalizeRawStrings(text: string): string {
  return text.replace(/r(#*)"([\s\S]*?)"\1/g, (_m, _hashes: string, body: string) => {
    const escaped = body.replace(/"/g, '\\"');
    return '"' + escaped.replace(/\n/g, '"\n"') + '"';
  });
}

/** Diesel: `users::table` — the module IS the table. */
const DIESEL_TABLE_RE = /\b([a-z][a-z0-9_]*)::table\b/;
/** reqwest: `client.get("url")` / `reqwest::get("url")`. */
const REQWEST_RE = /\b(?:\w*client|reqwest)(?:::|\.)\s*(get|post|put|patch|delete|head)\s*\(\s*(?:"([^"]+)")?/i;
const ENV_RE = /\benv::var(?:_os)?\s*\(\s*"([^"]+)"/;
/** lapin (AMQP): channel.basic_publish(exchange, routing_key, ...) / basic_consume(queue, ...). */
const AMQP_PUB_RE = /\.\s*basic_publish\s*\(\s*(?:"([^"]*)")?/;
const AMQP_CON_RE = /\.\s*basic_consume\s*\(\s*(?:"([^"]*)")?/;

export function extractRustDataSources(lines: string[]): DataSourceInfo[] {
  const normLines = normalizeRawStrings(lines.join("\n")).split("\n");
  const sources: DataSourceInfo[] = extractSqlStringDataSources(normLines);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;

    const diesel = line.match(DIESEL_TABLE_RE);
    if (diesel) {
      sources.push({
        kind: "database",
        name: "diesel",
        target: diesel[1]!,
        entity: diesel[1]!,
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const req = line.match(REQWEST_RE);
    if (req) {
      sources.push({ kind: "api-call", name: req[1]!.toUpperCase(), target: req[2] ?? null, calls: [], line: lineNo });
      continue;
    }

    const env = line.match(ENV_RE);
    if (env) {
      sources.push({ kind: "env", name: "env::var", target: env[1]!, calls: [], line: lineNo });
      continue;
    }

    const pub = line.match(AMQP_PUB_RE);
    if (pub) {
      sources.push({ kind: "queue-publish", name: "AMQP: basic_publish", target: pub[1] || null, calls: [], line: lineNo });
      continue;
    }
    const con = line.match(AMQP_CON_RE);
    if (con) {
      sources.push({ kind: "queue-consume", name: "AMQP: basic_consume", target: con[1] || null, calls: [], line: lineNo });
    }
  }

  return sources;
}
