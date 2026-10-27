import type { FileAnalysis, SchemaOp } from "../../../types/analysis.js";
import { fkRelation, replaySchema } from "../shared/schema-replay.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { GO_LINE } from "./index.js";

/**
 * SQL migrations replayed into one schema.
 *
 * Per file, the tables come from the spec's CREATE TABLE classes; this pass
 * adds what the file then does to them (`FileAnalysis.schemaOps`): ALTER
 * TABLE … ADD / DROP / RENAME COLUMN, MySQL CHANGE, ADD … FOREIGN KEY …
 * REFERENCES, RENAME TO, RENAME TABLE, DROP TABLE.
 *
 * Project-wide, a directory of versioned migrations — Flyway `V2__x.sql`,
 * `0002_x.sql`, golang-migrate `000002_x.up.sql`, timestamped
 * `20240101120000_x.sql`, Prisma and Diesel directories — is replayed in version order (`V10` after `V2`;
 * down / undo scripts and Flyway repeatables never) into the schema it ends
 * with: an ALTER-added column joins its table, a FK added later is an edge,
 * a dropped table is gone, a table dropped and created again is one node —
 * declared where its current form was created. Sibling chains for several
 * databases (`migrations/postgresql/`, `migrations/sqlite/`) are one schema:
 * the first dialect's tables stand for the rest.
 */
export class SqlMigrationEntities extends EntityExtractor {
  readonly languages = ["sql" as const];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const schemaOps = schemaOpsOf(ctx.lines);
    // Every foreign key the file states is a many-to-one edge; a replayed
    // chain rebuilds them from the schema it ends with.
    const relations = schemaOps.filter((o) => o.op === "add-foreign-key" && o.column && o.to).map((o) => fkRelation(o.table, o.column!, o.to!));
    return { entities: [], relations, ...(schemaOps.length ? { schemaOps } : {}) };
  }

  reconcileProject(analyses: FileAnalysis[]): void {
    const byDir = new Map<string, Array<{ a: FileAnalysis; version: bigint[] }>>();
    const alone: FileAnalysis[] = [];
    for (const a of analyses) {
      if (a.language !== "sql") continue;
      // A down / undo script restores the schema before its migration: none of its tables is the schema's.
      if (isUndoScript(a.filePath)) {
        a.classes = a.classes.filter((c) => !c.decorators.includes("table") && !c.decorators.includes("enum"));
        // Nor is what it queries: the views and tables it puts back are the old schema's.
        a.dataSources = a.dataSources.filter((d) => d.kind !== "database");
        const kept = (a.entityRelations ?? []).filter((r) => r.orm !== "sql");
        if (kept.length) a.entityRelations = kept;
        else delete a.entityRelations;
        continue;
      }
      if (!a.schemaOps?.length) continue;
      const slot = migrationSlot(a.filePath);
      if (!slot) {
        alone.push(a);
        continue;
      }
      (byDir.get(slot.chain) ?? byDir.set(slot.chain, []).get(slot.chain)!).push({ a, version: slot.version });
    }
    for (const chain of byDir.values()) {
      chain.sort((x, y) => compareVersions(x.version, y.version) || (x.a.filePath < y.a.filePath ? -1 : 1));
      replaySchema(chain.map((c) => c.a));
    }
    // One schema kept per database: `migrations/{postgresql,mysql,sqlite}/` are the
    // same tables in three dialects — the first dialect's chain stands for them all.
    const variants = new Map<string, string[]>();
    for (const chain of byDir.keys()) {
      const segs = chain.split("/");
      const at = segs.findIndex((s) => DIALECT_RANK.has(s.toLowerCase()));
      if (at < 0) continue;
      const key = [...segs.slice(0, at), "*", ...segs.slice(at + 1)].join("/");
      (variants.get(key) ?? variants.set(key, []).get(key)!).push(chain);
    }
    for (const chains of variants.values()) {
      if (chains.length < 2) continue;
      const rank = (c: string) => DIALECT_RANK.get(c.split("/").find((s) => DIALECT_RANK.has(s.toLowerCase()))!.toLowerCase())!;
      chains.sort((x, y) => rank(x) - rank(y));
      for (const other of chains.slice(1)) {
        for (const { a } of byDir.get(other)!) {
          a.classes = a.classes.filter((c) => !c.decorators.includes("table"));
          const kept = (a.entityRelations ?? []).filter((r) => r.orm !== "sql");
          if (kept.length) a.entityRelations = kept;
          else delete a.entityRelations;
        }
      }
    }
    // A script that alters what it creates (`schema.sql` with a trailing
    // ALTER TABLE … ADD COLUMN) ends with that schema too.
    for (const a of alone) replaySchema([a]);
  }
}

/** Dialect directories of one migration set, in the order one stands for the others. */
const DIALECT_RANK = new Map(["postgresql", "postgres", "pg", "mysql", "mariadb", "sqlite", "sqlite3", "mssql", "sqlserver", "oracle", "h2"].map((d, i) => [d, i]));

// ─── Per file: the schema changes a script states ───────────────────────────

/** One name part, bare or quoted in any dialect's quotes. */
const IDENT_PART = String.raw`(?:\[[^\]]+\]|"[^"]+"|` + "`[^`]+`" + String.raw`|[\w$]+)`;
/** A name, schema-qualified or not: `accounting."order"`, `[dbo].[Match]`, `league.club`. */
const IDENT = String.raw`(?:${IDENT_PART}(?:\.${IDENT_PART})*)`;
const unquote = (s: string): string => s.replace(/[[\]"`]/g, "");

/** Statements with their first line: `;`-terminated, comments blanked. */
function statements(lines: string[]): Array<{ text: string; line: number }> {
  const out: Array<{ text: string; line: number }> = [];
  let buf = "";
  let start = 0;
  let inBlock = false;
  lines.forEach((raw, i) => {
    let l = raw;
    if (inBlock) {
      const end = l.indexOf("*/");
      if (end < 0) return;
      l = l.slice(end + 2);
      inBlock = false;
    }
    l = l.replace(/\/\*.*?\*\//g, " ");
    const open = l.indexOf("/*");
    if (open >= 0) {
      l = l.slice(0, open);
      inBlock = true;
    }
    l = l.replace(/--.*$/, "");
    // A `GO` batch separator ends the statement as a `;` does.
    if (GO_LINE.test(l)) {
      if (buf.trim()) out.push({ text: buf.trim(), line: start });
      buf = "";
      return;
    }
    if (!buf.trim()) start = i + 1;
    for (const ch of l) {
      if (ch === ";") {
        if (buf.trim()) out.push({ text: buf.trim(), line: start });
        buf = "";
        start = i + 1;
      } else buf += ch;
    }
    buf += "\n";
  });
  if (buf.trim()) out.push({ text: buf.trim(), line: start });
  return out;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Split an ALTER TABLE's actions (or a CREATE's columns) at top-level commas. */
function actions(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const NOT_A_COLUMN = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|FULLTEXT|SPATIAL|EXCLUDE|PERIOD)\b/i;

export function schemaOpsOf(lines: string[]): SchemaOp[] {
  const ops: SchemaOp[] = [];
  for (const { text, line } of statements(lines)) {
    const create = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+)?(?:TEMPORARY|TEMP)\s+|UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${IDENT})`, "i").exec(text);
    if (create) {
      const table = unquote(create[1]!);
      ops.push({ op: "create-table", table, line });
      const open = text.indexOf("(", create[0].length);
      const close = open >= 0 ? matchingParen(text, open) : -1;
      for (const el of open >= 0 && close > open ? actions(text.slice(open + 1, close)) : []) {
        const e = el.replace(/\s+/g, " ").trim();
        const ref = new RegExp(String.raw`\bREFERENCES\s+(${IDENT})`, "i").exec(e);
        if (!ref) continue;
        const tableFk = new RegExp(String.raw`^(?:CONSTRAINT\s+${IDENT}\s+)?FOREIGN\s+KEY\s*\(\s*(${IDENT})`, "i").exec(e);
        const col = tableFk ? tableFk[1]! : NOT_A_COLUMN.test(e) ? null : new RegExp(String.raw`^(${IDENT})`).exec(e)?.[1];
        if (col) ops.push({ op: "add-foreign-key", table, column: unquote(col), to: unquote(ref[1]!), line });
      }
      continue;
    }
    // A dropped view leaves the schema as a dropped table does (one namespace in the database).
    const drop = /^DROP\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW)\s+(?:IF\s+EXISTS\s+)?([^;]+?)(?:\s+(?:CASCADE|RESTRICT))?\s*$/i.exec(text);
    if (drop) {
      for (const t of drop[1]!.split(",")) ops.push({ op: "drop-table", table: unquote(t.trim()), line });
      continue;
    }
    const renameTable = new RegExp(String.raw`^RENAME\s+TABLE\s+(${IDENT})\s+TO\s+(${IDENT})`, "i").exec(text);
    if (renameTable) {
      ops.push({ op: "rename-table", table: unquote(renameTable[1]!), to: unquote(renameTable[2]!), line });
      continue;
    }
    const alter = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${IDENT})\s+([\s\S]+)$`, "i").exec(text);
    if (!alter) continue;
    const table = unquote(alter[1]!);
    for (const act of actions(alter[2]!)) {
      const a = act.replace(/\s+/g, " ").trim();
      let m: RegExpExecArray | null;
      if ((m = new RegExp(String.raw`^RENAME\s+TO\s+(${IDENT})`, "i").exec(a))) {
        ops.push({ op: "rename-table", table, to: unquote(m[1]!), line });
      } else if ((m = new RegExp(String.raw`^RENAME\s+(?:COLUMN\s+)?(${IDENT})\s+TO\s+(${IDENT})`, "i").exec(a))) {
        ops.push({ op: "rename-column", table, column: unquote(m[1]!), to: unquote(m[2]!), line });
      } else if ((m = new RegExp(String.raw`^CHANGE\s+(?:COLUMN\s+)?(${IDENT})\s+(${IDENT})`, "i").exec(a))) {
        if (unquote(m[1]!) !== unquote(m[2]!)) ops.push({ op: "rename-column", table, column: unquote(m[1]!), to: unquote(m[2]!), line });
      } else if ((m = new RegExp(String.raw`^ADD\s+(?:CONSTRAINT\s+${IDENT}\s+)?FOREIGN\s+KEY\s*\(\s*(${IDENT})[^)]*\)\s*REFERENCES\s+(${IDENT})`, "i").exec(a))) {
        ops.push({ op: "add-foreign-key", table, column: unquote(m[1]!), to: unquote(m[2]!), line });
      } else if ((m = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(.+)$/i.exec(a)) && !NOT_A_COLUMN.test(m[1]!)) {
        const def = new RegExp(String.raw`^(${IDENT})\s*([^\s(]+(?:\([^)]*\))?)?`).exec(m[1]!.replace(/^\(\s*|\s*\)$/g, ""));
        if (!def) continue;
        const column = unquote(def[1]!);
        ops.push({ op: "add-column", table, column, type: def[2] ?? null, line });
        const ref = new RegExp(String.raw`\bREFERENCES\s+(${IDENT})`, "i").exec(m[1]!);
        if (ref) ops.push({ op: "add-foreign-key", table, column, to: unquote(ref[1]!), line });
      } else if ((m = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENT})`, "i").exec(a)) && !/^DROP\s+(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN|DEFAULT|CHECK)\b/i.test(a)) {
        ops.push({ op: "drop-column", table, column: unquote(m[1]!), line });
      }
    }
  }
  return ops;
}

// ─── Project: replay a chain ─────────────────────────────────────────────────

/**
 * The version a migration file's name states, or null for a file that is not
 * a versioned migration (a schema dump, a seed, a down / undo script, a
 * Flyway repeatable `R__`).
 */
export function migrationVersion(filePath: string): bigint[] | null {
  return migrationSlot(filePath)?.version ?? null;
}

/**
 * Where a migration sits in its chain: the chain (the directory holding the
 * versioned scripts) and its version. Prisma keeps one script per directory,
 * versioned by the directory (`migrations/20230101000000_init/migration.sql`),
 * and so does Diesel (`migrations/2023-01-01-000000_init/up.sql`).
 */
function migrationSlot(filePath: string): { chain: string; version: bigint[] } | null {
  const parts = filePath.split("/");
  const base = parts[parts.length - 1]!;
  // Diesel: `migrations/2022-03-02-210038_update_cars/up.sql`, its `down.sql` beside it never.
  if ((base === "migration.sql" || base === "up.sql") && parts.length >= 3) {
    const dir = /^(\d[\d-]*)_/.exec(parts[parts.length - 2]!);
    return dir ? { chain: parts.slice(0, -2).join("/") + "/", version: [BigInt(dir[1]!.replace(/-/g, ""))] } : null;
  }
  const version = fileVersion(base);
  return version ? { chain: parts.slice(0, -1).join("/") + "/", version } : null;
}

/** `000002_x.down.sql`, Flyway `U2__x.sql`, Diesel `<version>_x/down.sql`. */
function isUndoScript(filePath: string): boolean {
  const parts = filePath.split("/");
  const base = parts[parts.length - 1]!;
  if (/\.down\.sql$|_down\.sql$|^U\d[\w.]*__/i.test(base)) return true;
  return base.toLowerCase() === "down.sql" && parts.length >= 2 && /^\d[\d-]*_/.test(parts[parts.length - 2]!);
}

function fileVersion(base: string): bigint[] | null {
  if (/\.down\.sql$|_down\.sql$|^U\d/i.test(base) || /^R__/i.test(base)) return null;
  const flyway = /^V(\d+(?:[._]\d+)*)__/i.exec(base);
  const plain = flyway ? null : /^(\d+)[_.-]/.exec(base);
  const digits = flyway ? flyway[1]!.split(/[._]/) : plain ? [plain[1]!] : null;
  return digits ? digits.map((d) => BigInt(d)) : null;
}

function compareVersions(a: bigint[], b: bigint[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0n;
    const y = b[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

