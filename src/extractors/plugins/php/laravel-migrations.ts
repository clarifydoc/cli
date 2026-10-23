import type { ClassInfo, FileAnalysis, PropertyInfo, SchemaOp } from "../../../types/analysis.js";
import { pluralize } from "../shared/inflection.js";
import { fkRelation, replaySchema } from "../shared/schema-replay.js";

/**
 * Laravel migrations (`database/migrations/2024_01_01_000000_create_clubs_table.php`):
 * the schema their `up()` builds.
 *
 *   Schema::create('clubs', function (Blueprint $table) {
 *       $table->id();
 *       $table->string('name');
 *       $table->foreignId('league_id')->constrained();      // → leagues.id
 *       $table->timestamps();
 *   });
 *   Schema::table('clubs', function (Blueprint $table) { $table->dropColumn('crest'); });
 *
 * Per file: each `Schema::create` is a table class (decorated `table`, then
 * `laravel`) with its typed columns, and every change is a `schemaOp` —
 * columns added in `Schema::table`, `dropColumn`, `renameColumn`, foreign keys
 * (`foreignId(…)->constrained()`, `->references(…)->on(…)`, `foreign(…)`),
 * `Schema::drop[IfExists]`, `Schema::rename`. Only `up()` counts, with the
 * methods it calls on `$this`: `down()` undoes it. Project-wide, the migrations replay in file-name order (Laravel
 * runs them so), and a table an Eloquent model maps takes its place: the model
 * gets the table's columns and keys.
 */

const MIGRATION_PATH = /(?:^|\/)database\/migrations\/[^/]+\.php$/i;

export const isLaravelMigration = (filePath: string, source: string): boolean => MIGRATION_PATH.test(filePath) && source.includes("Schema::");

/** Blueprint helpers that add several columns, or one under a fixed name. */
const COMPOSITE_COLUMNS: Record<string, (arg: string | null) => Array<[string, string]>> = {
  id: (arg) => [[arg ?? "id", "bigIncrements"]],
  timestamps: () => [["created_at", "timestamp"], ["updated_at", "timestamp"]],
  timestampsTz: () => [["created_at", "timestampTz"], ["updated_at", "timestampTz"]],
  nullableTimestamps: () => [["created_at", "timestamp"], ["updated_at", "timestamp"]],
  softDeletes: (arg) => [[arg ?? "deleted_at", "timestamp"]],
  softDeletesTz: (arg) => [[arg ?? "deleted_at", "timestampTz"]],
  rememberToken: () => [["remember_token", "string"]],
  morphs: (arg) => (arg ? [[`${arg}_id`, "unsignedBigInteger"], [`${arg}_type`, "string"]] : []),
  nullableMorphs: (arg) => (arg ? [[`${arg}_id`, "unsignedBigInteger"], [`${arg}_type`, "string"]] : []),
  uuidMorphs: (arg) => (arg ? [[`${arg}_id`, "uuid"], [`${arg}_type`, "string"]] : []),
};

/** Blueprint calls that change no column of their own. */
const NOT_A_COLUMN = new Set([
  "index", "unique", "primary", "fullText", "spatialIndex", "foreign", "dropForeign", "dropIndex", "dropUnique",
  "dropPrimary", "dropColumn", "dropColumns", "renameColumn", "renameIndex", "engine", "charset", "collation",
  "comment", "temporary", "dropTimestamps", "dropSoftDeletes", "dropRememberToken", "dropMorphs", "after", "first",
]);

interface Block { kind: "create" | "table"; table: string; body: string; line: number }

/** Each method's body text, with the line it starts on. */
function methodBodies(source: string): Map<string, { text: string; line: number }> {
  const out = new Map<string, { text: string; line: number }>();
  for (const m of source.matchAll(/function\s+(\w+)\s*\([^)]*\)\s*(?::\s*\??[\w\\]+\s*)?\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        if (!out.has(m[1]!)) out.set(m[1]!, { text: source.slice(start, i), line: source.slice(0, start).split("\n").length });
        break;
      }
    }
  }
  return out;
}

/**
 * What `up()` runs: its own body, then the bodies of the file's methods it calls
 * on `$this` (`$this->createClubsTable()`), in call order, two levels deep.
 */
function upBodies(source: string): Array<{ text: string; line: number }> {
  const methods = methodBodies(source);
  const up = methods.get("up");
  if (!up) return [];
  const out = [up];
  const seen = new Set(["up"]);
  const follow = (body: { text: string }, depth: number): void => {
    if (depth > 2) return;
    for (const m of body.text.matchAll(/\$this->(\w+)\s*\(/g)) {
      const callee = methods.get(m[1]!);
      if (!callee || seen.has(m[1]!) || m[1] === "down") continue;
      seen.add(m[1]!);
      out.push(callee);
      follow(callee, depth + 1);
    }
  };
  follow(up, 1);
  return out;
}

const lineOf = (text: string, index: number, base: number): number => base + text.slice(0, index).split("\n").length - 1;

/** `Schema::create('t', function (Blueprint $table) { … })` / `Schema::table(…)` blocks of `up()`. */
function blocksOf(up: { text: string; line: number }): Block[] {
  const out: Block[] = [];
  // `static function (Blueprint $table): void use ($x) {` — modifiers, return type and `use` all optional.
  for (const m of up.text.matchAll(/Schema::(create|table)\(\s*['"]([\w.]+)['"]\s*,\s*(?:static\s+)?(?:function\s*\([^)]*\)|fn\s*\([^)]*\)\s*=>)\s*(?:use\s*\([^)]*\)\s*)?(?::\s*\??\w+\s*)?\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let end = up.text.length;
    for (let i = start; i < up.text.length; i++) {
      const c = up.text[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = i; break; }
    }
    out.push({ kind: m[1] as Block["kind"], table: m[2]!, body: up.text.slice(start, end), line: lineOf(up.text, m.index!, up.line) });
  }
  return out;
}

const firstString = (args: string): string | null => /^\s*['"]([\w.]+)['"]/.exec(args)?.[1] ?? null;

/** The table `foreignId('club_id')->constrained()` points at: its argument, else the column's name plural. */
function constrainedTable(column: string, chain: string): string | null {
  const m = /->constrained\(\s*(?:['"]([\w.]+)['"])?/.exec(chain);
  if (!m) return null;
  return m[1] ?? (column.endsWith("_id") ? pluralize(column.slice(0, -3)) : null);
}

export function readLaravelMigration(source: string): { tables: ClassInfo[]; ops: SchemaOp[] } {
  const tables: ClassInfo[] = [];
  const all: SchemaOp[] = [];
  // Each body's changes in its own line order, the bodies in the order `up()` runs them.
  for (const body of upBodies(source)) {
    const ops: SchemaOp[] = [];
    for (const block of blocksOf(body)) {
      const cls: ClassInfo | null = block.kind === "create"
        ? { name: block.table, extends: null, implements: [], decorators: ["table", "laravel"], methods: [], properties: [], isExported: true, line: block.line, endLine: block.line }
        : null;
      if (cls) {
        tables.push(cls);
        ops.push({ op: "create-table", table: block.table, line: block.line });
      }
      const addColumn = (name: string, type: string, line: number): void => {
        if (cls) {
          if (!cls.properties.some((p) => p.name === name)) cls.properties.push(column(name, type));
        } else ops.push({ op: "add-column", table: block.table, column: name, type, line });
      };
      // One statement per `$table->…;`, its chain included.
      for (const st of block.body.matchAll(/\$\w+->(\w+)\(([^;]*?)\)((?:->\w+\([^;]*?\))*)\s*;/g)) {
        const [, verb, args, chain] = st as unknown as [string, string, string, string];
        const line = lineOf(block.body, st.index!, block.line);
        const name = firstString(args);
        if (verb === "dropColumn" || verb === "dropColumns") {
          const names = [...args.matchAll(/['"]([\w]+)['"]/g)].map((x) => x[1]!);
          for (const n of names) ops.push({ op: "drop-column", table: block.table, column: n, line });
          continue;
        }
        if (verb === "renameColumn") {
          const [from, to] = [...args.matchAll(/['"]([\w]+)['"]/g)].map((x) => x[1]!);
          if (from && to) ops.push({ op: "rename-column", table: block.table, column: from, to, line });
          continue;
        }
        if (verb === "foreign" && name) {
          const on = /->on\(\s*['"]([\w.]+)['"]/.exec(chain)?.[1];
          if (on) ops.push({ op: "add-foreign-key", table: block.table, column: name, to: on, line });
          continue;
        }
        const composite = COMPOSITE_COLUMNS[verb];
        if (composite) {
          for (const [n, t] of composite(name)) addColumn(n, t, line);
          continue;
        }
        if (NOT_A_COLUMN.has(verb) || !name) continue;
        addColumn(name, verb, line);
        const to = constrainedTable(name, chain) ?? /->references\([^)]*\)->on\(\s*['"]([\w.]+)['"]/.exec(chain)?.[1] ?? null;
        if (to) {
          ops.push({ op: "add-foreign-key", table: block.table, column: name, to, line });
          if (cls && !cls.implements.includes(to)) cls.implements.push(to);
        }
      }
    }
    for (const m of body.text.matchAll(/Schema::(dropIfExists|drop)\(\s*['"]([\w.]+)['"]/g)) {
      ops.push({ op: "drop-table", table: m[2]!, line: lineOf(body.text, m.index!, body.line) });
    }
    for (const m of body.text.matchAll(/Schema::rename\(\s*['"]([\w.]+)['"]\s*,\s*['"]([\w.]+)['"]/g)) {
      ops.push({ op: "rename-table", table: m[1]!, to: m[2]!, line: lineOf(body.text, m.index!, body.line) });
    }
    all.push(...ops.sort((a, b) => a.line - b.line));
  }
  return { tables, ops: all };
}

function column(name: string, type: string): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}

export const migrationRelations = (ops: readonly SchemaOp[]) =>
  ops.filter((o) => o.op === "add-foreign-key" && o.column && o.to).map((o) => fkRelation(o.table, o.column!, o.to!));

/**
 * The migrations replayed in file-name order (their timestamp prefix), then
 * each surviving table an Eloquent model maps — its `$table`, else the
 * snake-cased plural of its name — folded into that model: the model takes
 * the table's typed columns (keeping its own where they agree), and the
 * table's node and its key edges go — the model's own relations stand for
 * them; a key pointing at a mapped table points at its model.
 */
export function reconcileLaravelMigrations(analyses: FileAnalysis[]): void {
  const chain = analyses.filter((a) => a.language === "php" && MIGRATION_PATH.test(a.filePath) && a.schemaOps?.length)
    .sort((x, y) => (x.filePath < y.filePath ? -1 : 1));
  if (chain.length === 0) return;
  replaySchema(chain);
  const models = new Map<string, ClassInfo | null>();
  for (const a of analyses) {
    if (a.language !== "php") continue;
    for (const c of a.classes) {
      if (!c.decorators.includes("entity") || !c.decorators.includes("eloquent")) continue;
      const table = (c.tableName ?? pluralize(snake(c.name))).split(".").pop()!.toLowerCase();
      models.set(table, models.has(table) ? null : c);
    }
  }
  const modelOf = (table: string): ClassInfo | undefined => models.get(table.split(".").pop()!.toLowerCase()) ?? undefined;
  for (const a of chain) {
    const kept: ClassInfo[] = [];
    for (const c of a.classes) {
      const model = c.decorators.includes("laravel") ? modelOf(c.name) : undefined;
      if (!model) {
        kept.push({ ...c, implements: c.implements.map((t) => modelOf(t)?.name ?? t) });
        continue;
      }
      for (const p of c.properties) {
        const own = model.properties.find((x) => x.name === p.name);
        if (own) own.type ??= p.type;
        else model.properties.push({ ...p });
      }
      if (!model.tableName) model.tableName = c.name;
    }
    a.classes = kept;
    if (a.entityRelations) {
      a.entityRelations = a.entityRelations
        .filter((r) => !modelOf(r.fromEntity))
        .map((r) => (modelOf(r.toEntity) ? { ...r, toEntity: modelOf(r.toEntity)!.name } : r));
    }
  }
}

/** `MatchReport` → `match_report`. */
function snake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
