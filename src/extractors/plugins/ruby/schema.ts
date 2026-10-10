import type { ClassInfo, FileAnalysis, PropertyInfo, RailsSchemaTable } from "../../../types/analysis.js";

/**
 * Parse the `create_table` blocks of a Rails `db/schema.rb` (the consolidated
 * schema dump `ActiveRecord::Schema.define` writes) into a per-table column
 * list. ActiveRecord/Sequel models hold no column declarations in the model
 * class — the columns live here — so `applyRailsSchemaColumns` joins these onto
 * the matching model entities by table-name convention.
 *
 * Handles the forms that appear in real schema dumps:
 *   create_table "absences", id: :serial, force: :cascade do |t|
 *     t.date     "start_date", null: false
 *     t.integer  "employee_id", null: false
 *     t.string   "code", limit: 255, default: ""
 *     t.references "author", polymorphic: true
 *     t.timestamps
 *     t.index ["employee_id"], name: "..."   # skipped — not a column
 *   end
 *
 * The implicit primary key is reconstructed from the `create_table` options:
 * a default or `id: :<type>` table gets a leading `id` column; `id: false`
 * gets none; `primary_key: "x"` names a custom one.
 */
export function parseRailsSchema(lines: string[]): RailsSchemaTable[] {
  const tables: RailsSchemaTable[] = [];
  let current: { table: string; columns: PropertyInfo[]; seen: Set<string> } | null = null;

  const add = (name: string, type: string | null): void => {
    if (!current || current.seen.has(name)) return;
    current.seen.add(name);
    current.columns.push({ name, type, visibility: "public", isStatic: false, isReadonly: false });
  };

  for (const raw of lines) {
    const line = raw.trim();

    if (!current) {
      const m = /^create_table\s+(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))\s*(?:,\s*([^]*?))?\bdo\s*\|\s*\w+\s*\|/.exec(line);
      if (!m) continue;
      const table = (m[1] ?? m[2] ?? m[3])!;
      const opts = m[4] ?? "";
      current = { table, columns: [], seen: new Set() };

      // Reconstruct the implicit primary key from create_table options.
      const idType = /\bid:\s*:([a-z_]+)/.exec(opts)?.[1] ?? "integer";
      const pk = /\bprimary_key:\s*(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))/.exec(opts);
      if (pk) add((pk[1] ?? pk[2] ?? pk[3])!, idType);
      else if (!/\bid:\s*false\b/.test(opts)) add("id", idType);
      continue;
    }

    if (/^end\b/.test(line)) {
      tables.push({ table: current.table, columns: current.columns });
      current = null;
      continue;
    }

    // `t.timestamps` expands to the two audit columns Rails always adds.
    if (/^t\.timestamps\b/.test(line)) {
      add("created_at", "datetime");
      add("updated_at", "datetime");
      continue;
    }

    // `t.references "user"` / `t.belongs_to :user` → `user_id` (+ `user_type`
    // when polymorphic). These declare a FK column, not a typed column line.
    const ref = /^t\.(?:references|belongs_to)\s+(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))(.*)$/.exec(line);
    if (ref) {
      const base = (ref[1] ?? ref[2] ?? ref[3])!;
      add(`${base}_id`, "integer");
      if (/\bpolymorphic:\s*true\b/.test(ref[4] ?? "")) add(`${base}_type`, "string");
      continue;
    }

    // Non-column table directives — indexes and constraints carry no column.
    if (/^t\.(?:index|check_constraint|foreign_key|exclusion_constraint|unique_constraint)\b/.test(line)) {
      continue;
    }

    // Explicit `t.column "name", :type` form.
    const explicit = /^t\.column\s+(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))\s*,\s*:?([A-Za-z_]\w*)/.exec(line);
    if (explicit) {
      add((explicit[1] ?? explicit[2] ?? explicit[3])!, explicit[4] ?? null);
      continue;
    }

    // Typed column helper: `t.<type> "name"` (string, integer, datetime, uuid…).
    const col = /^t\.([a-z_]+)\s+(?:"([^"]+)"|'([^']+)'|:([A-Za-z_]\w*))/.exec(line);
    if (col) add((col[2] ?? col[3] ?? col[4])!, col[1]!);
  }

  return tables;
}

/** True when `source` looks like a Rails schema dump (vs. a normal Ruby file). */
export function isRailsSchemaFile(source: string): boolean {
  return /ActiveRecord::Schema(?:\[[^\]]*\])?\.define\b/.test(source) && /\bcreate_table\b/.test(source);
}

/**
 * Attach parsed `db/schema.rb` columns to the ActiveRecord/Sequel model
 * entities they belong to. Rails model class bodies declare no columns — they
 * live in the schema dump — so without this join every Rails entity renders
 * field-less in the Data Model view.
 *
 * Join is by table-name convention (`Absence` → `absences`), trying several
 * candidate spellings so namespaced models resolve too:
 *   - an explicit `self.table_name` override (carried as a `table:<name>`
 *     decorator by the entity extractor) — authoritative;
 *   - `pluralize(underscore(name))` for both the bare and fully-qualified name
 *     (`IstLoen::KmdIndberetning` → `ist_loen_kmd_indberetnings`);
 *   - a directory-derived prefix from `app/models/<dir>/...` for models defined
 *     inside a `module` block (whose extracted name has lost the namespace);
 *   - the un-pluralized forms, for the rare singular-table model.
 * First candidate present in the schema wins. Entities already carrying columns
 * (another ORM) are left untouched. Runs once over the whole project.
 */
export function joinSchemaColumns(analyses: FileAnalysis[]): void {
  // Collect every parsed table across schema files (usually exactly one).
  const tables = new Map<string, PropertyInfo[]>();
  for (const a of analyses) {
    for (const t of a.railsSchemaTables ?? []) {
      if (!tables.has(t.table)) tables.set(t.table, t.columns);
    }
  }
  if (tables.size === 0) return;

  // Pass 1: direct table-name match for each model entity.
  const entities: ClassInfo[] = [];
  for (const a of analyses) {
    for (const cls of a.classes) {
      if (!cls.decorators?.includes("entity")) continue;
      entities.push(cls);
      if (cls.properties.length > 0) continue; // already populated by some ORM

      for (const cand of tableNameCandidates(cls, a.filePath)) {
        const cols = tables.get(cand);
        if (cols) {
          cls.properties = cols.map((c) => ({ ...c }));
          break;
        }
      }
    }
  }

  // Pass 2: single-table inheritance — a subclass (`TimeDutyChangeRequest <
  // ChangeRequest`) has no table of its own; it shares the base class's table.
  // Walk each still-empty entity's `extends` chain to the nearest ancestor
  // entity that resolved columns and copy them. Iterate to a fixed point so
  // multi-level STI chains fill from the root down. (Abstract bases like an
  // `IdaModel` with no table stay empty, which correctly stops the walk.)
  const filledByBare = new Map<string, ClassInfo>();
  for (const cls of entities) {
    const bare = cls.name.split("::").pop()!;
    if (cls.properties.length > 0 && !filledByBare.has(bare)) filledByBare.set(bare, cls);
  }
  for (let guard = 0; guard < 50; guard++) {
    let changed = false;
    for (const cls of entities) {
      if (cls.properties.length > 0) continue;
      const parentBare = cls.extends?.split("::").pop();
      const parent = parentBare ? filledByBare.get(parentBare) : undefined;
      if (!parent) continue;
      cls.properties = parent.properties.map((c) => ({ ...c }));
      const bare = cls.name.split("::").pop()!;
      if (!filledByBare.has(bare)) filledByBare.set(bare, cls);
      changed = true;
    }
    if (!changed) break;
  }
}

/** Ordered table-name guesses for a model entity, most-authoritative first. */
function tableNameCandidates(cls: ClassInfo, filePath: string): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    if (s && !out.includes(s)) out.push(s);
  };

  // 1. Explicit `self.table_name` override.
  push(cls.decorators?.find((d) => d.startsWith("table:"))?.slice(6));

  const bare = cls.name.split("::").pop()!; // demodulized (`A::B` → `B`)
  const bareUnder = railsUnderscore(bare);
  const fullUnder = railsUnderscore(cls.name); // `A::B` → `a_b`

  // 2. Fully-qualified and bare convention names, pluralized then singular.
  push(railsPluralize(fullUnder));
  push(railsPluralize(bareUnder));
  push(fullUnder);
  push(bareUnder);

  // 3. Directory-derived namespace prefix for models defined inside a `module`
  //    block (the extracted name lost the namespace, e.g. `KmdIndberetning` in
  //    `app/models/ist_loen/kmd_indberetning.rb` → `ist_loen_` prefix).
  const dir = modelDirPrefix(filePath);
  if (dir) {
    push(dir + railsPluralize(bareUnder));
    push(dir + bareUnder);
  }

  return out;
}

/** `app/models/ist_loen/kmd_indberetning.rb` → `ist_loen_` (else ""). */
function modelDirPrefix(filePath: string): string {
  const m = /(?:^|\/)models\/(.+)\/[^/]+\.rb$/.exec(filePath.replace(/\\/g, "/"));
  return m ? m[1]!.split("/").filter(Boolean).join("_") + "_" : "";
}

/** `KmdIndberetning` / `IstLoen::KmdIndberetning` → `kmd_indberetning` / `ist_loen_kmd_indberetning`. */
export function railsUnderscore(name: string): string {
  return name
    .replace(/::/g, "/")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/[-/]/g, "_")
    .toLowerCase();
}

/** Naive Rails inflector: `user_role` → `user_roles`, `category` → `categories`. */
function railsPluralize(token: string): string {
  if (/[^aeiou]y$/.test(token)) return token.replace(/y$/, "ies");
  if (/(s|x|z|ch|sh)$/.test(token)) return token + "es";
  return token + "s";
}
