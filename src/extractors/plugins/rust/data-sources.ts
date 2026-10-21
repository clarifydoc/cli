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
    const escaped = body.replace(/[\\"]/g, "\\$&");
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

/** `client` on one line, `.post(url)` on the next: the verb a client's chain starts with. */
function chainedClientCall(lines: string[], i: number): RegExpMatchArray | null {
  const m = /^\s*\.\s*(get|post|put|patch|delete|head)\s*\(\s*(?:"([^"]+)")?/.exec(lines[i]!);
  if (!m) return null;
  let j = i - 1;
  while (j >= 0 && !lines[j]!.trim()) j--;
  return j >= 0 && /\b\w*client\s*$/i.test(lines[j]!) ? m : null;
}

/**
 * The URL a local holds, from its `let` above the call: a literal, or a
 * `format!` rendered with its literal arguments in place and every other one
 * a `${…}` hole (`format!("{}{}", base, "/getquote")` → `${base}/getquote`).
 */
function urlOfLocal(lines: string[], i: number, name: string | undefined): string | null {
  if (!name) return null;
  for (let j = i; j >= Math.max(0, i - 80); j--) {
    const m = new RegExp(`\\blet\\s+(?:mut\\s+)?${name}\\s*(?::[^=]+)?=\\s*(.*)$`).exec(lines[j]!);
    if (!m) continue;
    let rhs = m[1]!;
    for (let k = j + 1; k < lines.length && !/;\s*$/.test(rhs) && k < j + 20; k++) rhs += " " + lines[k]!.trim();
    rhs = rhs.replace(/;\s*$/, "").trim();
    const literal = /^"([^"]+)"(?:\.to_(?:string|owned)\(\))?$/.exec(rhs);
    if (literal) return literal[1]!;
    const fmt = /^format!\s*\(\s*"([^"]*)"\s*,?(.*)\)$/s.exec(rhs);
    return fmt ? renderFormat(fmt[1]!, splitTopLevel(fmt[2]!)) : null;
  }
  return null;
}

function renderFormat(template: string, args: string[]): string | null {
  let n = 0;
  let literal = /[^{}]/.test(template.replace(/\{[^}]*\}/g, ""));
  const out = template.replace(/\{[^}]*\}/g, () => {
    const a = (args[n++] ?? "").trim();
    const lit = /^"([^"]*)"$/.exec(a);
    if (lit) { literal = true; return lit[1]!; }
    return `\${${a.replace(/\s+/g, "")}}`;
  });
  return literal ? out : null;
}

/** Arguments split at top-level commas. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === "(" || c === "[" || c === "{")) depth++;
    if (!quoted && (c === ")" || c === "]" || c === "}")) depth--;
    if (!quoted && c === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

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

    const req = line.match(REQWEST_RE) ?? chainedClientCall(lines, i);
    if (req) {
      const target = req[2] ?? urlOfLocal(lines, i, /\(\s*([a-z_]\w*)\s*[),]/.exec(line.slice(req.index ?? 0))?.[1]);
      sources.push({ kind: "api-call", name: req[1]!.toUpperCase(), target, calls: [], line: lineNo });
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
