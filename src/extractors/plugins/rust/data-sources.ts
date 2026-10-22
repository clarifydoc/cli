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

/**
 * Rewrite `r#"..."#` / `r"..."` raw strings, and ordinary `"..."` strings that
 * run over several lines, into per-line `"..."` fragments
 * (`"DELETE FROM x⏎ WHERE …"` → `"DELETE FROM x"⏎"WHERE …"`). Comments and
 * char literals are stepped over, so a quote inside them opens nothing.
 */
export function normalizeRawStrings(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const raw = c === "r" && !/[\w]/.test(text[i - 1] ?? "") || (c === "b" && text[i + 1] === "r" && !/[\w]/.test(text[i - 1] ?? ""))
      ? /^b?r(#*)"/.exec(text.slice(i, i + 40))
      : null;
    if (raw) {
      const close = '"' + raw[1]!;
      const end = text.indexOf(close, i + raw[0].length);
      const stop = end < 0 ? text.length : end;
      const body = text.slice(i + raw[0].length, stop).replace(/[\\"]/g, "\\$&");
      out += '"' + body.replace(/\n/g, '"\n"') + '"';
      i = stop + close.length - 1;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? text.length : end;
      out += text.slice(i, stop);
      i = stop - 1;
    } else if (c === "'" && /^'(?:\\.|[^\\'\n])'/.test(text.slice(i, i + 4))) {
      const lit = /^'(?:\\.|[^\\'\n])'/.exec(text.slice(i, i + 4))![0];
      out += lit;
      i += lit.length - 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const body = text.slice(i + 1, j);
      out += '"' + (body.includes("\n") ? body.replace(/\\?\n(\s*)/g, '"\n$1"') : body) + '"';
      i = j;
    } else out += c;
  }
  return out;
}

/** Diesel: `users::table` — the module IS the table. */
const DIESEL_TABLE_RE = /\b([a-z][a-z0-9_]*)::table\b(?!\s*!)/;
/** `schema::users::dsl::users`, `…::dsl::{id, users}`, `…::dsl::*` inside a `use`. */
const DIESEL_DSL_RE = /\b([a-z][a-z0-9_]*)::dsl::(\*|\{[^}]*\}|[a-z]\w*(?:\s+as\s+\w+)?)/g;
/** A statement that writes the table its argument names. */
const DIESEL_WRITE_RE = /\b(insert_into|replace_into|update|delete)\s*\(\s*$/;

/**
 * The names a file's `use` statements bind to a Diesel table through its `dsl`
 * module: `use schema::match_report::dsl::{id, match_report}` binds
 * `match_report`; `dsl::*` binds the table's own name. Columns are not tables.
 */
function dieselDslTables(lines: string[]): { tables: Map<string, string>; modules: Set<string> } {
  const out = new Map<string, string>();
  const modules = new Set<string>();
  const text = lines.join("\n");
  for (const use of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\b[^;]*;/gm)) {
    for (const m of use[0].matchAll(/\b([a-z][a-z0-9_]*)::dsl\s*(?=[;,}])/g)) modules.add(m[1]!);
    for (const m of use[0].matchAll(DIESEL_DSL_RE)) {
      const table = m[1]!;
      const items = m[2] === "*" ? [table] : m[2]!.replace(/[{}]/g, "").split(",");
      for (const item of items) {
        const [name, alias] = item.trim().split(/\s+as\s+/);
        if (name === table) out.set(alias ?? name, table);
      }
    }
  }
  return { tables: out, modules };
}

/** `dsl::match_report` under `use schema::match_report::dsl`, or `match_report::dsl::match_report` written out. */
const DIESEL_QUALIFIED_DSL_RE = /\b(?:([a-z][a-z0-9_]*)::)?dsl::([a-z][a-z0-9_]*)\b(?!\s*::)/g;

/** The first Diesel table a line names, and where. */
function dieselTableOn(line: string, dsl: { tables: Map<string, string>; modules: Set<string> }, dslRe: RegExp | null, declaration: boolean): { table: string; at: number } | null {
  const hits: { table: string; at: number }[] = [];
  const own = DIESEL_TABLE_RE.exec(line);
  if (own) hits.push({ table: own[1]!, at: own.index });
  if (!declaration) {
    const local = dslRe?.exec(line);
    if (local) hits.push({ table: dsl.tables.get(local[1]!)!, at: local.index });
    for (const m of line.matchAll(DIESEL_QUALIFIED_DSL_RE)) {
      if (m[1] ? m[1] === m[2] : dsl.modules.has(m[2]!)) { hits.push({ table: m[2]!, at: m.index }); break; }
    }
  }
  return hits.sort((a, b) => a.at - b.at)[0] ?? null;
}

/** Whether the table named at `at` on line `i` is what an `insert_into(`/`update(`/`delete(` writes. */
function dieselWrite(lines: string[], i: number, at: number): string | undefined {
  const before = lines[i]!.slice(0, at);
  const own = DIESEL_WRITE_RE.exec(before);
  if (own) return own[1];
  if (before.trim()) return undefined;
  let j = i - 1;
  while (j >= 0 && !lines[j]!.trim()) j--;
  return j >= 0 ? DIESEL_WRITE_RE.exec(lines[j]!)?.[1] : undefined;
}
/** reqwest: `client.get("url")` / `reqwest::get("url")` / `context.client().get(url)`. */
const REQWEST_RE = /\b(?:\w*client(?:\s*\(\s*\))?|reqwest)(?:::|\.)\s*(get|post|put|patch|delete|head)\s*\(\s*(?:"([^"]+)")?/i;
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
  return j >= 0 && /\b\w*client(?:\s*\(\s*\))?\s*$/i.test(lines[j]!) ? m : null;
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
  const dsl = dieselDslTables(lines);
  const dslRe = dsl.tables.size
    ? new RegExp(`(?<![\\w:.])(${[...dsl.tables.keys()].join("|")})\\b(?!\\s*(?:::|:[^:]|=[^=>]|!))`)
    : null;

  let inUse = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    const lineNo = i + 1;
    const declaration = inUse || /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:use|fn|struct|mod)\b/.test(line);
    if (/^\s*(?:pub(?:\([^)]*\))?\s+)?use\b/.test(line)) inUse = true;
    if (inUse && line.includes(";")) inUse = false;

    const diesel = dieselTableOn(line, dsl, dslRe, declaration);
    if (diesel) {
      const { table } = diesel;
      const write = dieselWrite(lines, i, diesel.at);
      sources.push({
        kind: "database",
        name: write ? `diesel: ${write}` : "diesel",
        target: table,
        entity: table,
        access: write ? "write" : "read",
        calls: [],
        line: lineNo,
      });
      continue;
    }

    const req = line.match(REQWEST_RE) ?? chainedClientCall(lines, i);
    if (req) {
      const target = req[2] ?? urlOfLocal(lines, i, /\(\s*&?([a-z_]\w*)\s*[),]/.exec(line.slice(req.index ?? 0))?.[1]);
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
