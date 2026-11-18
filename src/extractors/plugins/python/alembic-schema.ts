import type { ClassInfo, PropertyInfo, SchemaOp } from "../../../types/analysis.js";
import { matchingParen } from "../shared/text-scan.js";

/**
 * Alembic `op.create_table` / `op.drop_table` (and kin) → table classes +
 * `SchemaOp`s. A `schema="league"` kwarg prefixes the table (`league.clubs`)
 * so the data model joins the schema-qualified name code touches; a same-named
 * decoy without a schema, or under another schema, stays a different table.
 */

export function alembicSchemaOf(source: string): { tables: ClassInfo[]; ops: SchemaOp[] } {
  const tables: ClassInfo[] = [];
  const ops: SchemaOp[] = [];
  // Gated on Alembic: a revision marker, an `alembic` import, or an `op.*_table` call.
  if (!/\balembic\b/.test(source) && !/\bop\.(?:create|drop|rename)_table\b/.test(source) &&
      !(/^revision\s*[:=]/m.test(source) && /^down_revision\s*[:=]/m.test(source))) {
    return { tables, ops };
  }
  // Only the upgrade path: a revision's `downgrade()` undoes the same file's creates.
  const upgrade = upgradeBody(source) ?? source;

  for (const call of findCalls(upgrade, "create_table")) {
    const table = firstStringArg(call.body);
    if (!table) continue;
    const name = qualify(table, schemaOf(call.body));
    const properties = columnsOf(call.body);
    tables.push({
      name,
      extends: null,
      implements: [],
      decorators: ["table", "alembic"],
      methods: [],
      properties,
      isExported: true,
      line: call.line,
      endLine: call.endLine,
    });
    ops.push({ op: "create-table", table: name, line: call.line });
  }

  for (const call of findCalls(upgrade, "drop_table")) {
    const table = firstStringArg(call.body);
    if (!table) continue;
    ops.push({ op: "drop-table", table: qualify(table, schemaOf(call.body)), line: call.line });
  }

  for (const call of findCalls(upgrade, "rename_table")) {
    const args = stringArgs(call.body);
    if (args.length < 2) continue;
    ops.push({
      op: "rename-table",
      table: qualify(args[0]!, schemaOf(call.body)),
      to: qualify(args[1]!, schemaOf(call.body)),
      line: call.line,
    });
  }

  for (const call of findCalls(upgrade, "add_column")) {
    const table = firstStringArg(call.body);
    const col = columnArg(call.body);
    if (!table || !col) continue;
    ops.push({
      op: "add-column",
      table: qualify(table, schemaOf(call.body)),
      column: col.name,
      type: col.type,
      line: call.line,
    });
  }

  for (const call of findCalls(upgrade, "drop_column")) {
    const args = stringArgs(call.body);
    if (args.length < 2) continue;
    ops.push({
      op: "drop-column",
      table: qualify(args[0]!, schemaOf(call.body)),
      column: args[1]!,
      line: call.line,
    });
  }

  return { tables, ops };
}

/**
 * The indented body of `def upgrade…`, padded with leading newlines so
 * `findCalls` line numbers still match the full file. A sibling `downgrade()`
 * is cut off — it undoes the same revision's creates.
 */
function upgradeBody(source: string): string | null {
  const m = /^([ \t]*)def[ \t]+upgrade\w*[ \t]*\([^)]*\)[ \t]*(?:->[^\n]*)?:[ \t]*\n/m.exec(source);
  if (!m) return null;
  const indent = m[1] ?? "";
  const start = m.index + m[0].length;
  const rest = source.slice(start);
  const next = new RegExp(String.raw`^${indent}(?:def[ \t]+\w+|class[ \t]+\w+)`, "m").exec(rest);
  const end = next ? start + next.index : source.length;
  return "\n".repeat(source.slice(0, start).split("\n").length - 1) + source.slice(start, end);
}

function qualify(table: string, schema: string | null): string {
  return schema ? `${schema}.${table}` : table;
}

/** `schema="league"` / `schema='cup'` / `schema=league` (a name). */
function schemaOf(body: string): string | null {
  const m = /\bschema\s*=\s*(?:["']([^"']+)["']|([A-Za-z_]\w*))/i.exec(body);
  return m?.[1] ?? m?.[2] ?? null;
}

function firstStringArg(body: string): string | null {
  const m = /^\s*["']([^"']+)["']/.exec(body);
  return m?.[1] ?? null;
}

function stringArgs(body: string): string[] {
  return [...body.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]!);
}

/** `sa.Column("name", sa.String(80))` → column properties (create_table body). */
function columnsOf(body: string): PropertyInfo[] {
  const out: PropertyInfo[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(/\bColumn\s*\(\s*["']([^"']+)["']\s*(?:,\s*(?:sa\.|sqlalchemy\.)?([A-Za-z_]\w*)\s*(?:\(|,))?/g)) {
    const name = m[1]!;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, type: m[2] ?? null, visibility: "public", isStatic: false, isReadonly: false });
  }
  return out;
}

/** The `sa.Column("capacity", sa.Integer())` handed to `op.add_column`. */
function columnArg(body: string): { name: string; type: string | null } | null {
  const m = /\bColumn\s*\(\s*["']([^"']+)["']\s*(?:,\s*(?:sa\.|sqlalchemy\.)?([A-Za-z_]\w*)\s*(?:\(|,))?/.exec(body);
  return m ? { name: m[1]!, type: m[2] ?? null } : null;
}

interface CallSpan {
  body: string;
  line: number;
  endLine: number;
}

/**
 * Each `op.<leaf>(…)` call: body is the text inside the outermost parens.
 * Multiline calls are kept whole so `schema=` after the columns still binds.
 */
function findCalls(source: string, leaf: string): CallSpan[] {
  const out: CallSpan[] = [];
  const re = new RegExp(String.raw`\bop\.${leaf}\s*\(`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const open = m.index + m[0].length - 1;
    const close = matchingParen(source, open);
    if (close < 0) continue;
    const before = source.slice(0, m.index);
    const line = before.split("\n").length;
    const body = source.slice(open + 1, close);
    const endLine = line + body.split("\n").length - 1;
    out.push({ body, line, endLine });
  }
  return out;
}
