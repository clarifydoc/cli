import type { ClassInfo, EntityRelation, FileAnalysis, PropertyInfo } from "../../../types/analysis.js";

/**
 * A chain of schema migrations replayed into the schema it ends with, from each
 * file's `schemaOps` in chain order: an added column joins its table, a foreign
 * key added later is an edge, a dropped table is gone, a renamed one keeps its
 * node, a table dropped and created again is one node — declared where its
 * current form was created. Each CREATE's class (decorated `table`) is replaced
 * by the table's final form. Used by every format that states migrations (SQL
 * scripts, Liquibase changelogs).
 */

interface TableState {
  /** The class the table's current CREATE produced, and the file it is in. */
  origin: ClassInfo;
  file: FileAnalysis;
  /** What the chain makes of it. */
  cls: ClassInfo;
  /** Foreign keys: column (lower case) → the column as written and the table it references. */
  fks: Map<string, { column: string; to: string }>;
}

export function fkRelation(table: string, column: string, to: string): EntityRelation {
  return { fromEntity: table, fromField: column, toEntity: to, cardinality: "many-to-one", foreignKey: column, orm: "sql", confidence: "EXTRACTED" };
}

const keyOf = (name: string): string => name.split(".").pop()!.toLowerCase();

export function replaySchema(chain: FileAnalysis[]): void {
  const state = new Map<string, TableState>();
  const touched = new Set<ClassInfo>();
  for (const file of chain) {
    for (const op of file.schemaOps ?? []) {
      const key = keyOf(op.table);
      const st = state.get(key);
      switch (op.op) {
        case "create-table": {
          const cls = file.classes.find((c) => c.decorators.includes("table") && keyOf(c.name) === key && c.line === op.line)
            ?? file.classes.find((c) => c.decorators.includes("table") && keyOf(c.name) === key);
          if (!cls) break;
          touched.add(cls);
          state.set(key, { origin: cls, file, cls: { ...cls, properties: [...cls.properties], implements: [...cls.implements] }, fks: new Map() });
          break;
        }
        case "drop-table":
          state.delete(key);
          break;
        case "rename-table":
          if (st && op.to) {
            state.delete(key);
            st.cls.name = op.to;
            state.set(keyOf(op.to), st);
          }
          break;
        case "add-column":
          if (st && op.column && !st.cls.properties.some((p) => p.name.toLowerCase() === op.column!.toLowerCase())) {
            st.cls.properties.push(column(op.column, op.type ?? null));
          }
          break;
        case "drop-column":
          if (st && op.column) {
            st.cls.properties = st.cls.properties.filter((p) => p.name.toLowerCase() !== op.column!.toLowerCase());
            st.fks.delete(op.column.toLowerCase());
          }
          break;
        case "rename-column":
          if (st && op.column && op.to) {
            st.cls.properties = st.cls.properties.map((p) => (p.name.toLowerCase() === op.column!.toLowerCase() ? { ...p, name: op.to! } : p));
            const fk = st.fks.get(op.column.toLowerCase());
            if (fk) {
              st.fks.delete(op.column.toLowerCase());
              st.fks.set(op.to.toLowerCase(), { column: op.to, to: fk.to });
            }
          }
          break;
        case "add-foreign-key":
          if (st && op.to) {
            if (!st.cls.implements.some((t) => keyOf(t) === keyOf(op.to!))) st.cls.implements.push(op.to);
            if (op.column) st.fks.set(op.column.toLowerCase(), { column: op.column, to: op.to });
          }
          break;
      }
    }
  }
  // Every CREATE the chain made is replaced by what the chain ends with: the
  // table's current form, in the file whose CREATE made it.
  const finals = new Map([...state.values()].map((st) => [st.origin, st.cls]));
  for (const file of chain) {
    file.classes = file.classes.flatMap((c) => (!touched.has(c) ? [c] : finals.has(c) ? [finals.get(c)!] : []));
    // The chain's foreign keys are the ones its final schema holds, each in
    // the file that declares its table.
    const kept = (file.entityRelations ?? []).filter((r) => r.orm !== "sql");
    const own = [...state.values()].filter((st) => st.file === file).flatMap((st) => [...st.fks.values()].map((fk) => fkRelation(st.cls.name, fk.column, fk.to)));
    if (kept.length || own.length) file.entityRelations = [...kept, ...own];
    else delete file.entityRelations;
  }
}

function column(name: string, type: string | null): PropertyInfo {
  return { name, type, visibility: "public", isStatic: false, isReadonly: false };
}
