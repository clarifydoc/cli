import type { DataSourceInfo } from "../../../types/analysis.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";
import { fnAt, readRustCode, rustClientRequests, type RustCode } from "./request-wrappers.js";
import { splitTopLevel as splitTopLevelWith } from "../../shared/split-top-level.js";

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

/**
 * The table modules a file imports from its Diesel `schema` module:
 * `use crate::schema::{club, match_report};`, `use db::schema::club;` — each a
 * table whose column paths (`club::name.eq(x)`) the file's queries use.
 */
function dieselSchemaModules(lines: string[]): Map<string, string> {
  // The name each module is used by → the table it is: `club` → club, `community::dsl as c` → community.
  const out = new Map<string, string>();
  const text = lines.join("\n");
  if (!/\bschema::/.test(text)) return out;
  for (const use of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\b[^;]*;/gm)) {
    for (const m of use[0].matchAll(/\bschema::(\{[^}]*\}|[a-z][a-z0-9_]*(?:::dsl)?(?:\s+as\s+[a-z]\w*)?)/g)) {
      for (const item of m[1]!.replace(/[{}]/g, "").split(",")) {
        const [path = "", alias] = item.trim().split(/\s+as\s+/);
        const table = path.trim().split("::")[0]!;
        const name = (alias ?? table).trim();
        if (/^[a-z][a-z0-9_]*$/.test(name) && /^[a-z][a-z0-9_]*$/.test(table) && table !== "dsl" && table !== "self" && name !== "dsl") out.set(name, table);
      }
    }
  }
  return out;
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
/** reqwest, ureq, surf: `client.get("url")` / `reqwest::get("url")` / `context.client().get(url)`. */
const REQWEST_RE = /\b(?:\w*client(?:\s*\(\s*\))?|reqwest|ureq|surf)(?:::|\.)\s*(get|post|put|patch|delete|head)\s*\(\s*(?:"([^"]+)")?/i;
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

/** A file's lines joined once, for the helper lookups of all its request calls. */
const joinedText = new WeakMap<string[], string>();

/**
 * `club_url(&self.base, id)` handed to a client verb, the helper `fn club_url(base: &str, id: u32) -> String`
 * this file declares with a lone `format!` as its body: its template with the arguments in place (a literal as
 * written, any other a `${…}` hole). `undefined` when the verb's argument is no call; null when it is one this
 * file cannot read (another file's helper, a body that does more than format).
 */
function urlOfHelperCall(lines: string[], line: string, verbAt: number): string | null | undefined {
  const call = /^\s*&?\s*((?:[A-Za-z_]\w*::)*)([A-Za-z_]\w*)\s*\(/.exec(line.slice(line.indexOf("(", verbAt) + 1));
  if (!call) return undefined;
  // A path (`urls::club_url(id)`) names a function of another module: this file's namesake is not it.
  const modulePath = call[1]!.replace(/::$/, "").split("::").filter((s) => s && s !== "self");
  const callee = call[2]!;
  const rest = line.slice(line.indexOf("(", verbAt) + 1 + call[0].length);
  let depth = 1;
  let end = -1;
  for (let k = 0; k < rest.length && end < 0; k++) {
    if (rest[k] === "(") depth++;
    else if (rest[k] === ")" && --depth === 0) end = k;
  }
  if (end < 0) return null;
  const args = splitTopLevel(rest.slice(0, end)).map((a) => a.trim().replace(/^&\s*(?:mut\s+)?/, ""));
  const name = callee;
  let text = joinedText.get(lines);
  if (text === undefined) joinedText.set(lines, (text = lines.join("\n")));
  const head = modulePath.length > 0 ? null : new RegExp(`(?:^|\\n)[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${name}\\s*(?:<[^>]*>)?\\s*\\(`).exec(text);
  // A helper this file does not declare — imported (`use urls::club_url;`) or reached through its module
  // (`urls::club_url(id)`): the call as a hole, which the project pass fills from the helper's own template
  // (`FunctionInfo.urlTemplate`) once it knows which module the name stands for.
  if (!head) {
    // Only a name the file binds itself — a `use` naming the helper, a `mod`/`use` naming the module before it.
    const binder = modulePath.at(-1) ?? name;
    const binds = new RegExp(`(?:^|\\n)[ \\t]*(?:pub(?:\\([^)]*\\))?\\s+)?(?:use\\b[^;]*\\b${binder}\\b[^;]*;|mod\\s+${binder}\\b)`).test(text);
    return binds ? `\${${modulePath.length > 0 ? `${binder}.` : ""}${name}(${args.join(", ")})}` : null;
  }
  // One declaration of the name only: a namesake in an `impl` or another module is no telling which one a call means.
  if (text.slice(head.index + head[0].length).search(new RegExp(`\\bfn\\s+${name}\\s*[(<]`)) >= 0) return null;
  const paramsEnd = closingAt(text, head.index + head[0].length - 1);
  const bodyStart = paramsEnd < 0 ? -1 : /^[^{;]*\{/.exec(text.slice(paramsEnd + 1))?.[0].length ?? -1;
  if (bodyStart < 0) return null;
  const params = splitTopLevel(text.slice(head.index + head[0].length, paramsEnd)).map((p) => p.trim().split(":")[0]!.trim().replace(/^mut\s+/, "")).filter((p) => p && p !== "self" && !/^&?\s*(?:mut\s+)?self$/.test(p));
  if (params.length !== args.length) return null;
  // The body: exactly one `format!(…)`, as the tail expression or a `return`.
  const open = paramsEnd + bodyStart;
  const close = closingAt(text, open);
  if (close < 0) return null;
  const body = text.slice(open + 1, close);
  const fmt = /^\s*(?:return\s+)?format!\s*\(\s*"([^"]*)"\s*,?([\s\S]*)\)\s*;?\s*$/.exec(body);
  if (!fmt) return null;
  const rendered = renderFormat(fmt[1]!, splitTopLevel(fmt[2]!));
  if (rendered === null) return null;
  return rendered.replace(/\$\{([A-Za-z_]\w*)\}/g, (hole, v: string) => {
    const at = params.indexOf(v);
    if (at < 0) return hole;
    const a = args[at]!;
    const lit = /^"([^"]*)"$/.exec(a);
    return lit ? lit[1]! : /^\d+$/.test(a) ? a : `\${${a.replace(/\s+/g, "")}}`;
  });
}

/** The index of the bracket closing the one at `open` (`(`, `{` or `[`), string literals skipped; -1 when none. */
export function closingAt(text: string, open: number): number {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (c === '"') {
      for (k++; k < text.length && text[k] !== '"'; k++) if (text[k] === "\\") k++;
    } else if (c === "(" || c === "{" || c === "[") depth++;
    else if ((c === ")" || c === "}" || c === "]") && --depth === 0) return k;
  }
  return -1;
}

export function renderFormat(template: string, args: string[]): string | null {
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
export function splitTopLevel(text: string): string[] {
  return splitTopLevelWith(text, { quotes: "\"" });
}

export function extractRustDataSources(lines: string[]): DataSourceInfo[] {
  const normLines = normalizeRawStrings(lines.join("\n")).split("\n");
  const sources: DataSourceInfo[] = extractSqlStringDataSources(normLines);
  const dsl = dieselDslTables(lines);
  const dslRe = dsl.tables.size
    ? new RegExp(`(?<![\\w:.])(${[...dsl.tables.keys()].join("|")})\\b(?!\\s*(?:::|:[^:]|=[^=>]|!))`)
    : null;

  const schemaModules = dieselSchemaModules(lines);
  // A column path (`report::creator_id.eq(id)`) names its table's module: never `table`/`dsl`, a call or a deeper path.
  const columnRe = schemaModules.size
    ? new RegExp(`(?<![\\w:.])(${[...schemaModules.keys()].join("|")})::(?!table\\b|dsl\\b)[a-z_][a-z0-9_]*\\b(?!\\s*(?:::|\\(|!))`)
    : null;
  /** Tables a row was already recorded for in the statement the scan is in. */
  const statementTables = new Set<string>();

  // Functions and their parameters, read once when the file makes a client request at all.
  let rc: RustCode | null | undefined;
  const code = () => (rc === undefined ? (rc = /client|reqwest|ureq|surf/i.test(lines.join("\n")) ? readRustCode(lines) : null) : rc);
  const paramsAt = (i: number) => {
    const r = code();
    return r ? fnAt(r, r.lineStarts[i]! + (lines[i]!.length - lines[i]!.trimStart().length))?.params : undefined;
  };
  const requestRows = code() ? rustClientRequests(code()!) : [];
  sources.push(...requestRows);

  let inUse = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*\/\//.test(line)) continue;
    if (i > 0 && /[;{}]\s*$/.test(lines[i - 1]!)) statementTables.clear();
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
      statementTables.add(table);
      continue;
    }

    // A query whose table comes from a helper (`report_joins(id).filter(report::post_id.eq(p)).first(conn)`)
    // still reads the table its column paths name — once per statement.
    const column = !declaration ? columnRe?.exec(line) : null;
    const columnTable = column ? schemaModules.get(column[1]!) ?? column[1]! : null;
    if (columnTable && !statementTables.has(columnTable)) {
      statementTables.add(columnTable);
      sources.push({ kind: "database", name: "diesel", target: columnTable, entity: columnTable, access: "read", calls: [], line: lineNo });
      continue;
    }

    const direct = line.match(REQWEST_RE);
    const req = direct ?? chainedClientCall(lines, i);
    if (req) {
      const name = /\(\s*&?([a-z_]\w*)\s*[),]/.exec(line.slice(req.index ?? 0))?.[1];
      // A local's URL, else the wrapper's own parameter (`client.get(url)` in `fn fetch(url: &str)`) as a hole its callers fill.
      const viaHelper = req[2] === undefined ? urlOfHelperCall(lines, line, req.index ?? 0) : undefined;
      const target = req[2] ?? (viaHelper !== undefined ? viaHelper : urlOfLocal(lines, i, name) ?? (name && paramsAt(i)?.has(name) ? `\${${name}}` : null));
      sources.push({ kind: "api-call", name: req[1]!.toUpperCase(), target, calls: [], line: lineNo, column: direct ? direct.index! : line.search(/\S/) });
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
