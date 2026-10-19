import { readFile } from "fs/promises";
import { join } from "path";
import type { FileAnalysis } from "../types/analysis.js";
import { tableFrom } from "../extractors/plugins/shared/sql-string-sources.js";

/**
 * What a team's own wrappers mean, said once in `.clarifydoc/config.json`
 * instead of in a plugin:
 *
 *     "extract": {
 *       "httpCalls": [{ "call": "apiGet", "method": "GET" }, { "call": "http.send", "methodArg": 0, "urlArg": 1 }],
 *       "routes":    [{ "call": "registerRoute", "methodArg": 0, "pathArg": 1 }],
 *       "db":        [{ "call": "db.exec", "sqlArg": 0 }, { "call": "repo.save", "tableArg": 0, "access": "write" }]
 *     }
 *
 * Each call site whose arguments are literals becomes what the plugins
 * emit for the frameworks they know — an api-call, a route, a database
 * access — so the route linker, traces and the data model treat it the same.
 * A call whose URL, path or table is not a literal is left alone. Opt-in:
 * only files whose text names a configured call are read again.
 */

export interface HttpCallPattern {
  call: string;
  method?: string;
  methodArg?: number;
  urlArg?: number;
}
export interface RoutePattern {
  call: string;
  method?: string;
  methodArg?: number;
  pathArg?: number;
}
export interface DbPattern {
  call: string;
  access?: "read" | "write";
  tableArg?: number;
  sqlArg?: number;
}
export interface ExtractPatterns {
  httpCalls?: HttpCallPattern[];
  routes?: RoutePattern[];
  db?: DbPattern[];
}

const CALL_NAME = /^[A-Za-z_$][\w$]*(?:(?:\.|::|->)[A-Za-z_$][\w$]*)*$/;
const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 10;

/** The `extract` section, loosely checked: a bad entry is dropped with a warning, never fatal. */
export function validateExtract(raw: unknown, warn: (m: string) => void): ExtractPatterns | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warn('"extract" must be an object of httpCalls / routes / db lists; ignored');
    return undefined;
  }
  const b = raw as Record<string, unknown>;
  const out: ExtractPatterns = {};
  const list = <T>(key: "httpCalls" | "routes" | "db", check: (e: Record<string, unknown>, i: number) => T | null) => {
    const v = b[key];
    if (v === undefined) return;
    if (!Array.isArray(v)) return warn(`"extract.${key}" must be an array; ignored`);
    const kept: T[] = [];
    v.forEach((e, i) => {
      if (!e || typeof e !== "object" || typeof (e as { call?: unknown }).call !== "string" || !CALL_NAME.test((e as { call: string }).call)) {
        return warn(`extract.${key}[${i}] needs a "call" (a function or method name); ignored`);
      }
      const ok = check(e as Record<string, unknown>, i);
      if (ok) kept.push(ok);
    });
    if (kept.length) (out as Record<string, unknown>)[key] = kept;
  };
  const verb = (v: unknown) => (typeof v === "string" && /^[A-Za-z]+$/.test(v) ? v.toUpperCase() : undefined);
  list<HttpCallPattern>("httpCalls", (e) => ({ call: e.call as string, ...(verb(e.method) ? { method: verb(e.method)! } : {}), ...(isIndex(e.methodArg) ? { methodArg: e.methodArg } : {}), ...(isIndex(e.urlArg) ? { urlArg: e.urlArg } : {}) }));
  list<RoutePattern>("routes", (e) => ({ call: e.call as string, ...(verb(e.method) ? { method: verb(e.method)! } : {}), ...(isIndex(e.methodArg) ? { methodArg: e.methodArg } : {}), ...(isIndex(e.pathArg) ? { pathArg: e.pathArg } : {}) }));
  list<DbPattern>("db", (e, i) => {
    if (!isIndex(e.tableArg) && !isIndex(e.sqlArg)) {
      warn(`extract.db[${i}] (${e.call as string}) needs "tableArg" or "sqlArg"; ignored`);
      return null;
    }
    return { call: e.call as string, ...(e.access === "read" || e.access === "write" ? { access: e.access } : {}), ...(isIndex(e.tableArg) ? { tableArg: e.tableArg } : {}), ...(isIndex(e.sqlArg) ? { sqlArg: e.sqlArg } : {}) };
  });
  return Object.keys(out).length ? out : undefined;
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas. */
function argsAt(text: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  let quote = "";
  for (let i = open; i < text.length && i < open + 4000; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") {
        cur += text[++i] ?? "";
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1 && ch === "(") continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (cur.trim()) args.push(cur.trim());
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  return null;
}

/** A string literal's value; a template's text with its `${…}` kept as holes. Null for anything else. */
function literal(arg: string | undefined): string | null {
  const m = arg ? /^(["'`])([\s\S]*)\1$/.exec(arg.trim()) : null;
  return m ? m[2]! : null;
}

export interface ExtractCounts {
  httpCalls: number;
  routes: number;
  db: number;
}

export async function applyExtractPatterns(analyses: FileAnalysis[], projectRoot: string, patterns: ExtractPatterns): Promise<ExtractCounts> {
  const counts: ExtractCounts = { httpCalls: 0, routes: 0, db: 0 };
  const all = [...(patterns.httpCalls ?? []), ...(patterns.routes ?? []), ...(patterns.db ?? [])];
  if (all.length === 0) return counts;
  const regexOf = (call: string) => new RegExp(`(?<![\\w$.>:])${call.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
  for (const a of analyses) {
    let text: string;
    try {
      text = await readFile(join(projectRoot, a.filePath), "utf-8");
    } catch {
      continue;
    }
    if (!all.some((p) => text.includes(p.call))) continue;
    const lineAt = (i: number) => {
      let n = 1;
      for (let k = 0; k < i; k++) if (text.charCodeAt(k) === 10) n++;
      return n;
    };
    const sites = (call: string) => [...text.matchAll(regexOf(call))].map((m) => ({ line: lineAt(m.index!), args: argsAt(text, m.index! + m[0].length - 1) ?? [] }));
    // An access a plugin already read is the same access: confirmed, not repeated.
    const has = (kind: string, line: number, target: string) => {
      const hit = a.dataSources.find((d) => d.kind === kind && d.line === line && d.target === target);
      if (hit && kind === "database") hit.declared = true;
      return !!hit;
    };

    for (const p of patterns.httpCalls ?? []) {
      for (const s of sites(p.call)) {
        const url = literal(s.args[p.urlArg ?? 0]);
        if (!url) continue;
        const method = p.method ?? (p.methodArg !== undefined ? literal(s.args[p.methodArg])?.toUpperCase() : undefined);
        if (has("api-call", s.line, url)) continue;
        a.dataSources.push({ kind: "api-call", name: method ? `${method} ${url}` : p.call, target: url, line: s.line, calls: [] });
        counts.httpCalls++;
      }
    }
    for (const p of patterns.routes ?? []) {
      for (const s of sites(p.call)) {
        const path = literal(s.args[p.pathArg ?? 0]);
        if (!path) continue;
        const method = p.method ?? (p.methodArg !== undefined ? literal(s.args[p.methodArg])?.toUpperCase() ?? null : null);
        if (a.routes.some((r) => r.line === s.line && r.path === path)) continue;
        a.routes.push({ path, httpMethod: method ?? null, kind: "api", handler: null, calls: [], middleware: [], line: s.line });
        counts.routes++;
      }
    }
    for (const p of patterns.db ?? []) {
      for (const s of sites(p.call)) {
        const sql = p.sqlArg !== undefined ? literal(s.args[p.sqlArg]) : null;
        const fromSql = sql ? tableFrom(sql) : null;
        const table = p.tableArg !== undefined ? literal(s.args[p.tableArg]) : fromSql?.table.split(".").pop() ?? null;
        if (!table || !/^[A-Za-z_][\w.]*$/.test(table)) continue;
        if (has("database", s.line, table)) continue;
        const access = p.access ?? (fromSql ? (/^(select|with)$/i.test(fromSql.verb) ? "read" : "write") : undefined);
        a.dataSources.push({ kind: "database", name: p.call, target: table, entity: table, line: s.line, calls: [], declared: true, ...(access ? { access } : {}) });
        counts.db++;
      }
    }
  }
  return counts;
}
