import type { RegexLangSpec } from "../shared/regex-base.js";
import { extractClassesWithSpec } from "../shared/regex-base.js";
import type { ClassInfo, DataSourceInfo, ImportInfo, ScreenInfo } from "../../../types/analysis.js";
import { heexSigils, readHeex } from "./heex.js";
import { attachEctoSchema, attachPatternKeys, extractEctoRelations, extractElixirRequestAccess, extractPhoenixRoutes } from "./phoenix.js";
import { extractSqlStringDataSources } from "../shared/sql-string-sources.js";

/** Last dotted segment of an Elixir module alias (`MyApp.Accounts.User` → `User`). */
function lastSeg(mod: string): string {
  const parts = mod.split(".");
  return parts[parts.length - 1] || mod;
}

// ─── Imports ───────────────────────────────────────────────────────────────

const DIRECTIVE_RE = /^\s*(import|alias|use|require)\s+([A-Z][\w.]*)(.*)$/;

/**
 * `import`/`alias`/`use`/`require` lines as imports of the module they name,
 * with the name the file then calls it by: the last segment (`alias
 * MyApp.Accounts.User` → `User`), the `as:` name, or each member of a
 * multi-alias (`alias MyApp.Accounts.{User, Token}` — over several lines too).
 */
export function extractElixirImports(lines: string[]): ImportInfo[] {
  const out: ImportInfo[] = [];
  const push = (source: string, name: string, line: number): void => {
    out.push({ source, specifiers: [name], isDefault: false, isNamespace: false, isType: false, line });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = DIRECTIVE_RE.exec(lines[i] ?? "");
    if (!m) continue;
    const [, kind, mod, rest] = m;
    if (kind === "alias" && mod!.endsWith(".") && rest!.trimStart().startsWith("{")) {
      const uncommented = (line: string): string => line.replace(/#.*$/, "");
      let text = uncommented(rest!);
      let j = i;
      while (!text.includes("}") && j + 1 < lines.length && j - i < 50) text += " " + uncommented(lines[++j] ?? "");
      const inner = text.slice(text.indexOf("{") + 1, text.indexOf("}") >= 0 ? text.indexOf("}") : undefined);
      for (const item of inner.split(",")) {
        const member = item.trim();
        if (/^[A-Z][\w.]*$/.test(member)) push(mod! + member, lastSeg(member), i + 1);
      }
      continue;
    }
    const as = kind === "alias" ? /,\s*as:\s*([A-Z]\w*)/.exec(rest!) : null;
    push(mod!, as ? as[1]! : lastSeg(mod!), i + 1);
  }
  return out;
}

// ─── Ecto data access ──────────────────────────────────────────────────────

// `Repo.`, and the project's other repos: `ClickhouseRepo.`, `League.IngestRepo.`.
const ECTO_REPO_RE = /\b(?:[A-Z]\w*\.)*\w*Repo\.(all|get|get!|get_by|get_by!|one|one!|exists\?|aggregate|delete_all|update_all|preload)\s*\(\s*([A-Z][\w.]*)/g;
// `from(x in Schema, …)`, and a schemaless query over a table named as a string: `from(e in "events_v2", …)`.
// A query built by a function (`from(e in Base.events_query(site))`) names the table it is handed, if any.
const ECTO_FROM_RE = /\bfrom\s*\(?\s*\w+\s+in\s+(?:([A-Z][\w.]*)(\s*\(\s*"([a-z_]\w*)")?|"([a-z_][\w]*)")/g;
/** A `from(` whose binding (`x in Schema`) is on the next line, as `mix format` wraps it. */
const ECTO_FROM_OPEN_RE = /\bfrom\s*\(\s*$/;

/** `Repo.insert(cs)`, `|> Repo.update!()`, `Repo.delete(%Site{…})`, `Repo.insert_all(Event, rows)`, a project's audited `Repo.insert_with_audit!(…)`. */
const ECTO_WRITE_RE = /\b\w*Repo\.(insert_all|insert_or_update!?|(?:insert|update|delete)_with_audit!?|insert!?|update!?|delete!?)\s*\(\s*([^,)\n]*)/g;
/** A schema piped into a read or a bulk write: `Club |> Repo.get!(id)`, `|> Repo.delete_all()`. */
const ECTO_PIPED_RE = /\|>\s*(?:[A-Z]\w*\.)*\w*Repo\.(get!?|get_by!?|one!?|all|exists\?|aggregate|delete_all|update_all)\s*\(/;
/** A bulk write whose query starts on the next line: `Repo.delete_all(\n from(…`. */
const ECTO_BULK_OPEN_RE = /\b\w*Repo\.(delete_all|update_all)\s*\(\s*$/;
/** A read handed a query variable: `Repo.all(query)`, `|> Repo.one()`. */
// The first argument: a variable (`Repo.all(query)`), or nothing / options (`|> Repo.all(query: q)`).
const ECTO_VAR_READ_RE = /\b\w*Repo\.(all|one!?|exists\?|aggregate|stream)\s*\(\s*(?:([a-z_]\w*)\s*[,)]|[a-z_]\w*:|\))/g;

/**
 * Ecto data access. Reads through `Repo.<verb>(Schema, …)` and `from(x in
 * Schema, …)` name their schema (`MyApp.Accounts.User` → `User`). Writes take a
 * changeset or a struct: the schema is the `%Schema{}` the statement builds, the
 * `Schema.changeset(…)` it pipes through, or `insert_all`'s first argument —
 * else the row is a write of unknown entity, still a database access a trace
 * reaches. A read handed a query variable is a read of unknown entity (the
 * `from(…)` that built it has its own row).
 */
/** `Repo.preload(x, …)` / `|> Repo.preload(…)`: the call's argument text on its line. */
const ECTO_PRELOAD_RE = /(\|>\s*)?\b(?:[A-Z]\w*\.)*\w*Repo\.preload\s*\(/g;

/**
 * `Repo.preload(site, :team)`, `|> Repo.preload([:owners, team: :members])`:
 * a read of each association it names. The association's schema is declared
 * on whichever schema has it, so the row only names the association
 * (`Repo.preload(:team)`) and `ElixirEntityExtractor.reconcileProject` types it.
 */
export function ectoPreloads(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes("preload")) continue;
    for (const m of line.matchAll(ECTO_PRELOAD_RE)) {
      // The argument text, to the paren that closes the call (or the line's end).
      let depth = 1;
      let j = m.index! + m[0].length;
      for (; j < line.length && depth > 0; j++) {
        if ("([{".includes(line[j]!)) depth++;
        else if (")]}".includes(line[j]!)) depth--;
      }
      const args = line.slice(m.index! + m[0].length, depth === 0 ? j - 1 : j);
      // Unpiped, the first argument is the struct: `Repo.preload(Site, …)` is a schema read of its own.
      let spec = args;
      if (!m[1]) {
        const comma = topLevelComma(args);
        if (comma < 0 || /^\s*[A-Z]/.test(args)) continue;
        spec = args.slice(comma + 1);
      }
      const names = new Set<string>();
      for (const a of spec.replace(/"[^"]*"/g, "").matchAll(/(?<![\w:]):([a-z_]\w*)|\b([a-z_]\w*):(?!:)/g)) names.add((a[1] ?? a[2])!);
      for (const name of names) out.push({ kind: "database", name: `Repo.preload(:${name})`, target: null, calls: [], line: i + 1, access: "read" });
    }
  }
  return out;
}

function topLevelComma(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    else if (c === "," && depth === 0) return i;
  }
  return -1;
}

function extractElixirDataSources(lines: string[]): DataSourceInfo[] {
  const out: DataSourceInfo[] = [...obanJobs(lines), ...pubSubTopics(lines), ...httpCalls(lines), ...sqlStrings(lines), ...ectoPreloads(lines)];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const ln = i + 1;
    for (const m of line.matchAll(ECTO_REPO_RE)) {
      // `Repo.one(Sites.guests_query(site))`: a function building the query — a read of no named schema.
      if (!/^[A-Z]/.test(lastSeg(m[2]))) {
        out.push({ kind: "database", name: `Repo.${m[1]}`, target: null, calls: [], line: ln, access: "read" });
        continue;
      }
      const entity = lastSeg(m[2]);
      out.push({ kind: "database", name: `Repo.${m[1]}`, target: entity, calls: [], line: ln, entity, access: m[1]!.endsWith("_all") && m[1] !== "all" ? "write" : "read" });
    }
    // A query a bulk write wraps from the next line on is that write's.
    const bulk = i > 0 ? ECTO_BULK_OPEN_RE.exec(lines[i - 1] ?? "") ?? (i > 1 && ECTO_FROM_OPEN_RE.test(lines[i - 1] ?? "") ? ECTO_BULK_OPEN_RE.exec(lines[i - 2] ?? "") : null) : null;
    const fromRow = (m: RegExpMatchArray, at: number) => {
      // A schema is a module; `Base.events_query(…)` is a function building a query, over the table it is handed.
      const call = m[1] && (!/^[A-Z]/.test(lastSeg(m[1])) || m[2] !== undefined);
      const entity = call ? m[3] ?? null : m[1] ? lastSeg(m[1]) : m[4]!;
      if (!entity) return;
      out.push({ kind: "database", name: `from(${call ? `"${entity}"` : m[1] ?? `"${m[4]}"`})`, target: entity, calls: [], line: at, entity, ...(bulk ? { access: "write" as const } : {}) });
    };
    for (const m of line.matchAll(ECTO_FROM_RE)) fromRow(m, ln);
    if (ECTO_FROM_OPEN_RE.test(line)) {
      const next = (lines[i + 1] ?? "").replace(/^\s*/, "from(");
      for (const m of next.matchAll(ECTO_FROM_RE)) fromRow(m, ln);
    }
    const piped = ECTO_PIPED_RE.exec(line);
    if (piped) {
      const subject = pipedSchema(lines, i);
      if (subject) {
        out.push({ kind: "database", name: `Repo.${piped[1]}`, target: subject, calls: [], line: ln, entity: subject, access: /_all$/.test(piped[1]!) ? "write" : "read" });
        continue;
      }
    }
    for (const m of line.matchAll(ECTO_WRITE_RE)) {
      const entity = writeEntity(m[1]!, m[2]!.trim(), lines, i);
      out.push({ kind: "database", name: `Repo.${m[1]}`, target: entity, calls: [], line: ln, ...(entity ? { entity } : {}), access: "write" });
    }
    for (const m of line.matchAll(ECTO_VAR_READ_RE)) {
      // `Repo.all(Site)` is ECTO_REPO_RE's; a variable or a piped query is this one.
      if (m[2] && /^[A-Z]/.test(m[2])) continue;
      if (!m[2] && !/\|>\s*(?:[A-Z]\w*\.)*\w*Repo\./.test(line)) continue;
      out.push({ kind: "database", name: `Repo.${m[1]}`, target: null, calls: [], line: ln, access: "read" });
    }
  }
  return out;
}

// ─── Raw SQL ─────────────────────────────────────────────────────────────────

const SQL_VERB_RE = /^\s*(?:SELECT|INSERT|UPDATE|DELETE|WITH|ALTER|TRUNCATE)\b/i;

/**
 * SQL in strings and heredocs (`Repo.query!("SELECT … FROM sessions_v2")`, a
 * migration's `execute """ UPDATE teams SET … """`), read by the shared SQL
 * reader at the string's first line. Documentation (`@doc`, `@moduledoc`) and
 * template sigils (`~H`, `~L`) are prose and markup, never statements.
 */
function sqlStrings(lines: string[]): DataSourceInfo[] {
  if (!/\b(?:SELECT|INSERT|UPDATE|DELETE)\b/.test(lines.join("\n"))) return [];
  const out: DataSourceInfo[] = [];
  const read = (sql: string, line: number) => {
    if (!SQL_VERB_RE.test(sql)) return;
    const literal = `"${sql.replace(/#\{[^}]*\}/g, "{}").replace(/\s+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}";`;
    for (const s of extractSqlStringDataSources([literal])) out.push({ ...s, line });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*@(?:moduledoc|doc|shortdoc)\b/.test(line)) {
      // Skip the documentation heredoc it opens.
      if (/"""\s*$/.test(line)) while (i + 1 < lines.length && !/^\s*"""/.test(lines[++i]!));
      continue;
    }
    const heredoc = /(~[sS])?"""\s*$/.exec(line);
    if (heredoc && !/~[A-RT-Za-rt-z]"""\s*$/.test(line)) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*"""/.test(lines[j]!); j++) body.push(lines[j]!);
      read(body.join(" "), i + 1);
      i = j;
      continue;
    }
    for (const m of line.matchAll(/(?<![~\w])"((?:[^"\\]|\\.)*)"/g)) read(m[1]!, i + 1);
  }
  return out;
}

// ─── Outgoing HTTP ───────────────────────────────────────────────────────────

const HTTP_CALL_RE = /\b(Req|HTTPoison|HTTPotion|Tesla|Finch)\.(get|post|put|patch|delete|head|options|request|build)!?\s*\(\s*(.*)$/;
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

/**
 * Requests through Req, HTTPoison, Tesla and Finch: `Req.post("https://…/#{id}/purge", opts)`,
 * `HTTPoison.get!(url)`, `Finch.build(:post, url, headers, body)`, `Req.request(url: url, method: :get)`.
 * The URL is a literal (its `#{…}` holes kept as `{…}`), a local or module attribute bound to one,
 * or unknown — a request all the same, which a trace reaches.
 */
function httpCalls(lines: string[]): DataSourceInfo[] {
  if (!/\b(?:Req|HTTPoison|HTTPotion|Tesla|Finch)\./.test(lines.join("\n"))) return [];
  const attrs = new Map<string, string>();
  for (const l of lines) {
    const m = /^\s*@(\w+)\s+"([^"]*)"\s*$/.exec(l);
    if (m && !attrs.has(m[1]!)) attrs.set(m[1]!, m[2]!);
  }
  const literal = (text: string): string => text.replace(/#\{([^}]*)\}/g, (_, x: string) => `{${x.trim()}}`);
  const urlOf = (expr: string, at: number): string | null => {
    const e = expr.trim();
    const str = /^"((?:[^"\\]|\\.)*)"/.exec(e);
    if (str) return literal(str[1]!);
    const attr = /^@(\w+)\b/.exec(e);
    if (attr) return attrs.get(attr[1]!) ?? null;
    const local = /^([a-z_]\w*)\b/.exec(e)?.[1];
    if (!local) return null;
    for (let j = at - 1; j >= 0 && at - j <= 25 && !/^\s*defp?\s/.test(lines[j + 1] ?? "x"); j--) {
      const m = new RegExp(`^\\s*${local}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|@(\\w+))\\s*$`).exec(lines[j]!);
      if (m) return m[1] !== undefined ? literal(m[1]) : attrs.get(m[2]!) ?? null;
      if (/^\s*defp?\s/.test(lines[j]!)) break;
    }
    return null;
  };
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HTTP_CALL_RE.exec(lines[i]!);
    if (!m) continue;
    const [, lib, fn, rest] = m;
    let verb: string | null = HTTP_VERBS.has(fn!) ? fn!.toUpperCase() : null;
    let urlExpr: string | null = rest!;
    if (fn === "build") {
      // `Finch.build(:post, url, headers, body)`; piped, the method is the subject.
      const args = rest!.split(",");
      const atom = /^\s*:(\w+)/.exec(args[0] ?? "");
      if (atom && HTTP_VERBS.has(atom[1]!)) verb = atom[1]!.toUpperCase();
      urlExpr = args.length > 1 ? args.slice(1).join(",") : null;
    }
    // Keyword options name the URL and method: `Req.post(url: url)`, `Req.request(url: u, method: :get)`.
    const kwUrl = /\burl:\s*([^,)]+)/.exec(rest!);
    if (kwUrl) urlExpr = kwUrl[1]!;
    const kwMethod = /\bmethod:\s*:(\w+)/.exec(rest!);
    if (kwMethod && HTTP_VERBS.has(kwMethod[1]!)) verb = kwMethod[1]!.toUpperCase();
    const target = urlExpr ? urlOf(urlExpr, i) : null;
    out.push({ kind: "api-call", name: verb && target ? `${verb} ${target}` : `${lib}.${fn}`, target, calls: [], line: i + 1 });
  }
  return out;
}

const OBAN_WORKER_RE = /^\s*use\s+Oban\.(?:Pro\.)?Worker\b/;
const OBAN_INSERT_RE = /\bOban\.insert(?:_all)?!?\s*\(/;
const JOB_NEW_RE = /\b([A-Z][\w.]*)\.new\s*\(/;

/**
 * Oban jobs as a queue a worker module is the channel of: `use Oban.Worker`
 * makes the module's `perform/1` consume it, and `Worker.new(args) |>
 * Oban.insert()` (or `Oban.insert!(Worker.new(args))`) enqueues onto it. Both
 * sides name the worker by its last segment, aliased or not.
 */
function obanJobs(lines: string[]): DataSourceInfo[] {
  const text = lines.join("\n");
  if (!text.includes("Oban")) return [];
  const out: DataSourceInfo[] = [];
  // A worker enqueuing itself (`%{id: id} |> new() |> Oban.insert()`, `__MODULE__.new(args)`).
  let ownWorker: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (OBAN_WORKER_RE.test(line)) {
      let mod: string | null = null;
      for (let j = i; j >= 0 && !mod; j--) mod = /^\s*defmodule\s+([A-Z][\w.]*)/.exec(lines[j]!)?.[1] ?? null;
      let perform = -1;
      for (let j = i + 1; j < lines.length && perform < 0; j++) if (/^\s*def\s+perform\s*\(/.test(lines[j]!)) perform = j;
      if (mod) {
        const channel = lastSeg(mod);
        ownWorker = channel;
        out.push({ kind: "queue-consume", name: "Oban.Worker", target: channel, entity: channel, calls: [], line: (perform >= 0 ? perform : i) + 1 });
      }
      continue;
    }
    if (!OBAN_INSERT_RE.test(line)) continue;
    // The job built in the same statement: on this line, in the call's arguments below, or up the pipeline feeding it.
    let job = JOB_NEW_RE.exec(line)?.[1] ?? null;
    const openCall = /\bOban\.insert(?:_all)?!?\s*\(\s*$/.test(line);
    for (let j = i + 1; openCall && !job && j < lines.length && j - i <= 3 && !/^\s*\)/.test(lines[j]!); j++) job = JOB_NEW_RE.exec(lines[j]!)?.[1] ?? null;
    for (let j = i - 1; !job && j >= 0 && i - j <= 8 && !/^\s*(?:def|defp)\b/.test(lines[j]!); j--) job = JOB_NEW_RE.exec(lines[j]!)?.[1] ?? null;
    if (!job && ownWorker) {
      for (let j = i; j >= 0 && i - j <= 8 && !job; j--) if (/(?:^|[\s(>])(?:__MODULE__\.)?new\s*\(/.test(lines[j]!)) job = ownWorker;
    }
    if (!job || job === "Map" || job === "MapSet" || job === "Date" || job === "DateTime") continue;
    const channel = job === "__MODULE__" && ownWorker ? ownWorker : lastSeg(job);
    out.push({ kind: "queue-publish", name: "Oban.insert", target: channel, entity: channel, calls: [], line: i + 1 });
  }
  return out;
}

const PUBSUB_RE = /\bPhoenix\.PubSub\.(broadcast!?|broadcast_from!?|local_broadcast|local_broadcast_from|direct_broadcast!?|subscribe|unsubscribe)\s*\(/;

/**
 * Phoenix PubSub topics: `Phoenix.PubSub.broadcast(App.PubSub, topic, msg)`
 * publishes to the topic, `subscribe(App.PubSub, topic)` consumes it. The
 * topic is a literal, a module attribute of the file (`@topic "scheduler"`),
 * a zero-arity function of the module (`topic()`), or another module's
 * (`App.Scheduler.topic()`) — then a `targetRef` the project pass reads from
 * that module's values (`elixirModuleValues`).
 */
function pubSubTopics(lines: string[]): DataSourceInfo[] {
  const text = lines.join("\n");
  if (!text.includes("PubSub")) return [];
  const own = elixirModuleValues(lines);
  const attrs = moduleAttributes(lines);
  const out: DataSourceInfo[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PUBSUB_RE.exec(lines[i]!);
    if (!m) continue;
    if (m[1] === "unsubscribe") continue;
    // The call's arguments, which may run onto the next lines.
    let args = lines[i]!.slice(m.index + m[0].length);
    for (let j = i + 1; j < lines.length && j - i <= 3 && !/\)/.test(args); j++) args += " " + lines[j]!.trim();
    const parts = splitTopLevel(args);
    const topicArg = (/_from/.test(m[1]!) ? parts[2] : parts[1])?.trim();
    if (!topicArg) continue;
    let target: string | null = null;
    let ref: string | undefined;
    const lit = /^"([^"#]*)"$/.exec(topicArg);
    const attr = /^@([a-z_]\w*)$/.exec(topicArg);
    const call = /^((?:[A-Z][\w]*\.)*[A-Z][\w]*\.)?([a-z_]\w*)(?:\(\s*\))?$/.exec(topicArg);
    if (lit) target = lit[1]!;
    else if (attr) target = attrs.get(attr[1]!) ?? null;
    else if (call && call[1]) {
      ref = `${call[1]}${call[2]}`;
      target = own[ref] ?? ref;
    } else if (call) {
      const mod = moduleAt(lines, i);
      target = (mod && own[`${mod}.${call[2]}`]) || null;
    }
    if (!target) continue;
    out.push({
      kind: m[1] === "subscribe" ? "queue-consume" : "queue-publish",
      name: `Phoenix.PubSub.${m[1]}`,
      target,
      ...(ref && target === ref ? { targetRef: ref } : {}),
      calls: [],
      line: i + 1,
    });
  }
  return out;
}

/** `@topic "scheduler"` module attributes holding a plain string, by name; one set twice is left out. */
function moduleAttributes(lines: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const clash = new Set<string>();
  for (const line of lines) {
    const m = /^\s*@([a-z_]\w*)\s+"([^"#\\]*)"\s*$/.exec(line);
    if (!m || m[1] === "moduledoc" || m[1] === "doc") continue;
    if (out.has(m[1]!) && out.get(m[1]!) !== m[2]) clash.add(m[1]!);
    out.set(m[1]!, m[2]!);
  }
  for (const k of clash) out.delete(k);
  return out;
}

/** The innermost `defmodule` enclosing line `i`, by indentation. */
function moduleAt(lines: string[], i: number): string | null {
  for (let j = i; j >= 0; j--) {
    const m = /^(\s*)defmodule\s+([A-Z][\w.]*)/.exec(lines[j]!);
    if (m && m[1]!.length < (/^\s*/.exec(lines[i]!)?.[0].length ?? 0)) return m[2]!;
  }
  return null;
}

/** Top-level comma-separated arguments up to the call's closing paren. */
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = false;
  for (const ch of args) {
    if (ch === '"') quote = !quote;
    if (!quote) {
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        if (depth === 0) break;
        depth--;
      } else if (ch === "," && depth === 0) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * A module's zero-arity functions that return a plain string, by
 * `Module.function` → `FileAnalysis.moduleValues`: `def topic, do: @topic`
 * (an attribute of the module), `def topic, do: "flags"`, or a `do … end`
 * body holding only that. What another module's `App.Storage.topic()` reads.
 */
export function elixirModuleValues(lines: string[]): Record<string, string> {
  if (!lines.some((l) => /^\s*def\s+[a-z_]\w*\s*(?:\(\s*\))?\s*(?:,\s*do:|do\s*$)/.test(l))) return {};
  const attrs = moduleAttributes(lines);
  const out: Record<string, string> = {};
  const valueOf = (expr: string): string | null => {
    const e = expr.trim();
    const lit = /^"([^"#\\]*)"$/.exec(e);
    if (lit) return lit[1]!;
    const attr = /^@([a-z_]\w*)$/.exec(e);
    return attr ? attrs.get(attr[1]!) ?? null : null;
  };
  for (let i = 0; i < lines.length; i++) {
    const inline = /^\s*def\s+([a-z_]\w*)\s*(?:\(\s*\))?\s*,\s*do:\s*(.+?)\s*$/.exec(lines[i]!);
    const block = inline ? null : /^\s*def\s+([a-z_]\w*)\s*(?:\(\s*\))?\s+do\s*$/.exec(lines[i]!);
    let value: string | null = null;
    if (inline) value = valueOf(inline[2]!);
    else if (block && /^\s*end\s*$/.test(lines[i + 2] ?? "")) value = valueOf(lines[i + 1] ?? "");
    const name = (inline ?? block)?.[1];
    const mod = name ? moduleAt(lines, i) : null;
    if (name && mod && value !== null) out[`${mod}.${name}`] = value;
  }
  return out;
}

/** The module a pipeline starts from (`Club\n |> where(…)\n |> Repo.all()`, `Club |> Repo.get!(id)`), or null. */
function pipedSchema(lines: string[], i: number): string | null {
  const head = (text: string): string | null => {
    const m = /^\s*(?:[a-z_]\w*\s*=\s*)?([A-Z][\w.]*)\s*(?:\|>|$)/.exec(text);
    return m && /^[A-Z]/.test(lastSeg(m[1]!)) ? lastSeg(m[1]!) : null;
  };
  if (!/^\s*\|>/.test(lines[i] ?? "")) {
    // `def by_name(n), do: Club |> Repo.get_by(name: n)`: the module the line's pipeline starts from.
    const own = /(?:^|[\s(=,]|do:)\s*([A-Z][\w.]*)\s*\|>/.exec(lines[i] ?? "");
    return own && /^[A-Z]/.test(lastSeg(own[1]!)) ? lastSeg(own[1]!) : null;
  }
  for (let j = i - 1; j >= 0 && i - j <= 8; j--) {
    if (/^\s*\|>/.test(lines[j] ?? "")) continue;
    return head(lines[j] ?? "");
  }
  return null;
}

/** The schema a write touches: `insert_all`'s module, a `%Schema{}` / `Schema.changeset(` in the statement or the pipeline feeding it. */
function writeEntity(verb: string, arg: string, lines: string[], i: number): string | null {
  if (verb === "insert_all") return /^([A-Z][\w.]*)$/.test(arg) ? lastSeg(arg) : null;
  const fromText = (text: string): string | null => {
    const struct = /%([A-Z][\w.]*)\s*\{/.exec(text);
    if (struct) return lastSeg(struct[1]!);
    const cs = /\b([A-Z][\w.]*)\.(?:changeset|\w+_changeset|create_changeset|update_changeset)\s*\(/.exec(text);
    return cs ? lastSeg(cs[1]!) : null;
  };
  const own = fromText(lines[i] ?? "");
  if (own) return own;
  // A pipeline: `%Site{} |> Site.changeset(attrs) |> Repo.insert()` over lines.
  if (/^\s*\|>/.test(lines[i] ?? "") || /\|>\s*(?:[A-Z]\w*\.)*\w*Repo\./.test(lines[i] ?? "")) {
    for (let j = i - 1; j >= 0 && i - j <= 8; j--) {
      const hit = fromText(lines[j] ?? "");
      if (hit) return hit;
      if (!/^\s*\|>/.test(lines[j] ?? "")) break;
    }
  }
  return null;
}

/**
 * Elixir regex spec. Modules (`defmodule`) map to the class concept; `def`/
 * `defp`/`defmacro` are functions (lowercase atoms, may end in `?`/`!`); blocks
 * are indent-delimited (`do … end`, conventionally 2-space indented).
 */
export const elixirSpec: RegexLangSpec = {
  language: "elixir",
  extensions: [".ex", ".exs"],
  indentBased: true,
  lineCommentPrefixes: ["#"],

  functionPatterns: [
    {
      // `def foo(...)`, `defp bar do`, `defmacro baz`. `defmodule` is excluded
      // (no whitespace after `def`). Private = defp/defmacrop.
      pattern: /^\s*(?:def|defp|defmacro|defmacrop)\s+([a-z_][\w?!]*)/,
      isExported: (line) => /^\s*(?:def|defmacro)\s/.test(line),
    },
  ],

  classPatterns: [
    { pattern: /^\s*defmodule\s+([A-Z][\w.]*)/ },
    { pattern: /^\s*defprotocol\s+([A-Z][\w.]*)/ },
  ],

  // Multi-aliases and `as:` need more than one line or one specifier.
  extractImports: (lines) => extractElixirImports(lines),

  importPatterns: [
    {
      // `import`/`alias`/`use`/`require Some.Module`
      pattern: /^\s*(?:import|alias|use|require)\s+([A-Z][\w.]*)/,
      getSource: (m) => m[1],
      getSpecifiers: (m) => {
        const parts = m[1].split(".");
        return [parts[parts.length - 1]];
      },
    },
  ],

  /**
   * `def show(conn, %{"id" => id})` — the second argument is a map pattern
   * whose keys are the request; the generic splitter hands it over in pieces
   * (`=>` reads as a bracket to it). Keep the map only under its `= name`
   * binding and drop the fragments; `attachPatternKeys` reads the keys from
   * the head line itself. `opts \\ []` keeps its name.
   */
  parseParam: (p) => {
    const t = p.trim();
    if (!t) return null;
    // `%{…} = params` binds the whole map; the splitter may hand the `= params`
    // tail over on a later fragment, so look for it on any piece. An unnamed
    // pattern has no name to bind — its keys are the parameters.
    const bound = t.match(/\}\s*=\s*([a-z_]\w*)\s*$/);
    if (bound) return { name: bound[1]!, type: null, defaultValue: null };
    if (t.startsWith("%") || /^["'\[{]|=>|^\w+\}$/.test(t)) return null;
    const m = t.match(/^([a-z_]\w*[?!]?)\s*(?:\\\\\s*(.+))?$/);
    return m ? { name: m[1]!, type: null, defaultValue: m[2]?.trim() ?? null } : null;
  },

  /**
   * Every Elixir `def` sits in a `defmodule`, so the generic pass already lists
   * each one as a method; overriding `extractClasses` makes the core drop the
   * top-level duplicate (it does so for any spec that provides the hook), which
   * is what lets the project-level handler join find `show` once, not twice.
   */
  extractClasses: (lines) => extractClassesWithSpec(lines, elixirSpec),

  /** `conn.body_params["x"]`, `get_req_header(conn, "x")`, `cast(attrs, [...])` — see `phoenix.ts`. */
  extractRequestAccess: (bodyLines) => extractElixirRequestAccess(bodyLines),

  /** Ecto `schema` fields → properties; action-head pattern keys → `requestAccess`. */
  postProcessClasses: (lines, classes) => {
    for (const cls of classes) {
      attachEctoSchema(lines, cls);
      attachPatternKeys(lines, cls.methods);
      nameEventClauses(lines, cls);
    }
    return classes;
  },

  /** `phx-*` events, links and forms in LiveView `~H"""` sigils (see heex.ts). */
  extractInteractiveElements: (lines) => heexSigils(lines).flatMap((s) => readHeex(s.text, s.firstLine).elements),
  /** A LiveView or LiveComponent module is a screen; its `~H` markup is the component tree. */
  extractScreens: (lines, filePath, classes) => liveViewScreens(lines, filePath, classes),

  extractRoutes: (lines) => extractPhoenixRoutes(lines),
  extractDataSources: (lines) => extractElixirDataSources(lines),
  /** `App.Storage.topic()` → the string the module's zero-arity function returns (see `elixirModuleValues`). */
  extractModuleValues: (lines) => elixirModuleValues(lines),
  /** Ecto `belongs_to` / `has_many` / `has_one` / `many_to_many` → entity relations (see `phoenix.ts`). */
  extractEntityRelations: (lines, classes, imports) => extractEctoRelations(lines, classes, imports),
};

/**
 * `def handle_event("save", params, socket)` — one function per event to
 * Phoenix, which dispatches on the literal. Each clause is named
 * `handle_event("save")` so a click on `phx-click="save"` reaches that clause's
 * calls and not every other event's.
 */
function nameEventClauses(lines: string[], cls: ClassInfo): void {
  for (const m of cls.methods) {
    if (m.name !== "handle_event") continue;
    const ev = /\bdef\s+handle_event\(\s*"([^"]+)"/.exec(lines[m.line - 1] ?? "")?.[1];
    if (ev) m.name = `handle_event("${ev}")`;
  }
}

const LIVE_MODULE_RE = /^\s*use\s+(?:Phoenix\.LiveView|Phoenix\.LiveComponent|[A-Z][\w.]*,\s*:(?:live_view|live_component))\b/;

function liveViewScreens(lines: string[], filePath: string, classes: ClassInfo[]): ScreenInfo[] {
  const sigils = heexSigils(lines);
  const screens: ScreenInfo[] = [];
  for (const cls of classes) {
    const body = lines.slice(cls.line - 1, cls.endLine);
    const use = body.find((l) => LIVE_MODULE_RE.test(l));
    if (!use) continue;
    const reads = sigils.filter((s) => s.startLine >= cls.line && s.startLine <= cls.endLine).map((s) => readHeex(s.text, s.firstLine));
    screens.push({
      name: cls.name,
      formType: /live_component|LiveComponent/.test(use) ? "LiveComponent" : "LiveView",
      caption: reads.find((r) => r.caption)?.caption ?? null,
      dimensions: null,
      components: reads.flatMap((r) => r.components),
      filePath,
      routePath: null,
      navigatesTo: reads.flatMap((r) => r.elements.filter((e) => e.request?.method === "GET").map((e) => e.request!.target)),
    });
  }
  return screens;
}
