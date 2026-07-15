import type {
  FileAnalysis,
  EntityGraph,
  EntityGraphNode,
  EntityGraphEdge,
  EntityGraphColumn,
  EntityModelRef,
  ClassGraph,
  TypeUsageKind,
  Confidence,
} from "../types/analysis.js";

/**
 * Build the project-wide entity-relationship graph rendered in the report's
 * "Data Model" (ER diagram) view.
 *
 * Nodes: every entity-decorated `ClassInfo` (ORM entities, SQL tables, enums)
 * with its columns. Edges: derived from each file's `entityRelations`, with
 * mirror pairs (e.g. `User.posts → Post` one-to-many and `Post.author → User`
 * many-to-one) collapsed into ONE relationship carrying crow's-foot
 * multiplicity at each end. Targets that don't resolve to a known entity
 * (e.g. polymorphic placeholders) are skipped so the diagram stays clean.
 */

/** Structural decorators that are NOT the originating ORM tag. */
const STRUCTURAL = new Set([
  "entity", "table", "enum", "view", "materialized-view",
  "index", "sequence", "schema", "type",
]);

const CONFIDENCE_RANK: Record<Confidence, number> = {
  EXTRACTED: 3,
  INFERRED: 2,
  AMBIGUOUS: 1,
};

/** The ORM tag on an entity ClassInfo (the decorator after the entity marker). */
export function ormOf(decs: readonly string[]): string | null {
  const i = decs.findIndex((d) => d === "entity" || d === "table" || d === "enum");
  const next = i >= 0 ? decs[i + 1] : undefined;
  return next && !STRUCTURAL.has(next) ? next : null;
}

/** Bare (last) segment of a possibly-namespaced name (`A::B` → `B`). */
function bareName(name: string | null): string | null {
  if (!name) return null;
  const seg = name.split("::").pop()!.trim();
  return /^[A-Za-z_]/.test(seg) ? seg : null;
}

/**
 * Mark classes that transitively inherit from a known entity as entities too,
 * across files. Per-file extraction can't see that `Employee < IdaModel` is an
 * ActiveRecord model when `IdaModel` lives in another file, nor resolve a
 * cross-file STI chain (`SupervisionTimeDutyChangeRequest < TimeDutyChangeRequest
 * < ChangeRequest < IdaModel`). This project-level fixpoint closes both gaps and
 * is language-agnostic (also helps JPA/EF/Sequel STI). It only ADDS the
 * `["entity", <orm>]` decorators — relations are still per-file.
 */
export function reconcileEntityInheritance(analyses: FileAnalysis[]): void {
  // Index every class by its bare name (superclass references are usually bare).
  const byBare = new Map<string, import("../types/analysis.js").ClassInfo[]>();
  for (const a of analyses) {
    for (const c of a.classes ?? []) {
      const b = bareName(c.name);
      if (!b) continue;
      const arr = byBare.get(b) ?? [];
      arr.push(c);
      byBare.set(b, arr);
    }
  }
  const isEntity = (c: { decorators?: string[] }) => (c.decorators ?? []).includes("entity");

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    for (const a of analyses) {
      for (const c of a.classes ?? []) {
        if (isEntity(c)) continue;
        const parentName = bareName(c.extends);
        if (!parentName) continue;
        const parent = (byBare.get(parentName) ?? []).find((p) => isEntity(p));
        if (!parent) continue;
        const orm = ormOf(parent.decorators ?? []) ?? "active-record";
        // jOOQ tables have no real STI — their subclasses are generated
        // artifacts (`XPath`, `XRecord`), not entities. Don't propagate.
        if (orm === "jooq") continue;
        c.decorators = [...(c.decorators ?? []), "entity", orm];
        changed = true;
      }
    }
  }
}

export function buildEntityGraph(analyses: FileAnalysis[]): EntityGraph {
  const nodes = new Map<string, EntityGraphNode>();
  const nameToIds = new Map<string, string[]>();

  // ── Pass 1: nodes (entities / tables / enums) ──
  for (const a of analyses) {
    for (const cls of a.classes ?? []) {
      const decs = cls.decorators ?? [];
      const isEntity = decs.includes("entity") || decs.includes("table");
      const isEnum = decs.includes("enum");
      if (!isEntity && !isEnum) continue;

      const id = `${a.filePath}::${cls.name}`;
      if (nodes.has(id)) continue;

      // The ORM tag is the decorator our entity extractor places immediately
      // after the lowercase `entity`/`table`/`enum` marker (e.g. ["Entity()",
      // "entity", "typeorm"]). Picking "first non-structural" would wrongly grab
      // the language's own raw decorator (`Entity()`, `ORM\Entity`).
      const markerIdx = decs.findIndex((d) => d === "entity" || d === "table" || d === "enum");
      const next = markerIdx >= 0 ? decs[markerIdx + 1] : undefined;
      const orm = (next && !STRUCTURAL.has(next)) ? next : (decs.includes("table") ? "sql" : null);
      const columns: EntityGraphColumn[] = (cls.properties ?? []).map((p) => ({
        name: p.name,
        type: p.type,
        isPrimaryKey: isPrimaryKey(p.name, p.type),
      }));

      nodes.set(id, {
        id,
        name: cls.name,
        orm,
        kind: isEnum ? "enum" : "entity",
        filePath: a.filePath,
        columns,
        line: cls.line,
      });
      // Index by full name AND bare last segment so a relation whose target is
      // written bare (`class_name: 'IstLoen::KmdIndberetning'` → "KmdIndberetning")
      // still resolves to a namespaced entity node.
      for (const key of new Set([cls.name, cls.name.split("::").pop()!])) {
        const arr = nameToIds.get(key) ?? [];
        if (!arr.includes(id)) arr.push(id);
        nameToIds.set(key, arr);
      }
    }
  }

  /** Resolve a relation's target entity name to a node id, preferring same-file. */
  function resolveTarget(name: string, fromFile: string): string | null {
    const ids = nameToIds.get(name);
    if (!ids || ids.length === 0) return null;
    return ids.find((id) => id.startsWith(`${fromFile}::`)) ?? ids[0]!;
  }

  // ── Pass 2: edges (mirror pairs merged into one relationship) ──
  interface Merge {
    a: string;
    b: string;
    aMany: boolean;
    bMany: boolean;
    fields: Set<string>;
    fk: string | null;
    joinTable: string | null;
    orm: string | null;
    confidence: Confidence | undefined;
    self: boolean;
  }
  const merged = new Map<string, Merge>();
  const fkByEntity = new Map<string, Set<string>>();

  for (const a of analyses) {
    for (const r of a.entityRelations ?? []) {
      // Resolve the source by name too: a relation usually lives in the same
      // file as its `fromEntity`, but jOOQ centralizes every FK in `Keys.java`,
      // so the owning table is defined elsewhere.
      const sameFileSrc = `${a.filePath}::${r.fromEntity}`;
      const srcId = nodes.has(sameFileSrc) ? sameFileSrc : resolveTarget(r.fromEntity, a.filePath);
      if (!srcId) continue;
      const tgtId = resolveTarget(r.toEntity, a.filePath);
      if (!tgtId) continue;

      if (r.foreignKey) {
        const set = fkByEntity.get(srcId) ?? new Set<string>();
        set.add(r.foreignKey);
        fkByEntity.set(srcId, set);
      }

      // Per-relation endpoint multiplicity.
      let srcMany = false;
      let tgtMany = false;
      if (r.cardinality === "many-to-one") srcMany = true;
      else if (r.cardinality === "one-to-many") tgtMany = true;
      else if (r.cardinality === "many-to-many") { srcMany = true; tgtMany = true; }
      // one-to-one → both stay "one".

      const self = srcId === tgtId;
      const [a1, b1] = srcId <= tgtId ? [srcId, tgtId] : [tgtId, srcId];
      const key = `${a1}\u0000${b1}`;
      let m = merged.get(key);
      if (!m) {
        m = { a: a1, b: b1, aMany: false, bMany: false, fields: new Set(), fk: null, joinTable: null, orm: null, confidence: undefined, self };
        merged.set(key, m);
      }
      // Map this relation's src/tgt multiplicity onto the canonical a/b ends.
      if (srcId === a1) {
        m.aMany = m.aMany || srcMany;
        m.bMany = m.bMany || tgtMany;
      } else {
        m.bMany = m.bMany || srcMany;
        m.aMany = m.aMany || tgtMany;
      }
      if (r.fromField) m.fields.add(r.fromField);
      if (r.foreignKey && !m.fk) m.fk = r.foreignKey;
      if (r.joinTable && !m.joinTable) m.joinTable = r.joinTable;
      if (r.orm && !m.orm) m.orm = r.orm;
      if (r.confidence && (!m.confidence || CONFIDENCE_RANK[r.confidence] > CONFIDENCE_RANK[m.confidence])) {
        m.confidence = r.confidence;
      }
    }
  }

  // Mark foreign-key columns on their owning entity (case-insensitive: jOOQ's
  // FK field constant `CASEID` maps to the table column `caseID`).
  for (const [id, fks] of fkByEntity) {
    const node = nodes.get(id);
    if (!node) continue;
    const lower = new Set([...fks].map((f) => f.toLowerCase()));
    for (const col of node.columns) if (fks.has(col.name) || lower.has(col.name.toLowerCase())) col.isForeignKey = true;
  }

  const edges: EntityGraphEdge[] = [];
  for (const m of merged.values()) {
    edges.push({
      source: m.a,
      target: m.b,
      sourceCardinality: m.aMany ? "many" : "one",
      targetCardinality: m.bMany ? "many" : "one",
      fields: [...m.fields].sort(),
      foreignKey: m.fk,
      joinTable: m.joinTable,
      orm: m.orm,
      confidence: m.confidence,
      selfRef: m.self,
    });
  }

  return {
    nodes: [...nodes.values()].sort((x, y) => x.id.localeCompare(y.id)),
    edges: edges.sort((x, y) => x.source.localeCompare(y.source) || x.target.localeCompare(y.target)),
  };
}

/** Heuristic primary-key detection from a column's name / encoded type. */
function isPrimaryKey(name: string, type: string | null): boolean {
  if (type && /@id\b|@@id|primary[_\s]?key|PrimaryGenerated|\[Key\]|\bPK\b/i.test(type)) {
    return true;
  }
  return name.toLowerCase() === "id";
}

/**
 * Data-position usage kinds — a model that holds the entity as data. Mirrors
 * the "data" category in data-model-blast.ts; kept as a local set to avoid an
 * import cycle (data-model-blast.ts already imports `ormOf` from this module).
 */
const DATA_KINDS: ReadonlySet<TypeUsageKind> = new Set(["field", "variable", "generic-arg"]);

/**
 * A class that holds *many* distinct entities as fields is infrastructure — an
 * ORM context (`DbSet<T>` per table), a schema/catalog holder (jOOQ's generated
 * `Tables`/`Sps`, which expose one field per table), a repository facade, or a
 * god-object — not a data/view model. A real DTO/view model represents one
 * entity or a small composite. Sources whose distinct-entity fan-out exceeds
 * this cap are dropped so they don't bury the genuine links. Tunable.
 */
const MAX_ENTITIES_PER_MODEL = 10;

/**
 * Enrich entity nodes with the data/view models that reference them.
 *
 * The ClassGraph already resolves every type-position reference between
 * classes/interfaces — including references INTO entities (a `UserDto` with a
 * `user: User` field yields the edge `UserDto → User`). This walks those edges
 * and attaches, to each entity node, the non-entity models that hold it in a
 * data position (field / variable / generic-arg). Pure type-reference reuse —
 * no naming or mapper heuristics.
 *
 * Joins on the ClassGraph edge's resolved target **id**, which shares the
 * `${filePath}::${name}` scheme with entity node ids. The id is already
 * import-disambiguated by `buildClassGraph`, so this stays precise even when
 * several entities share a bare name across sub-projects (a name join would
 * fan a single reference out onto every same-named entity). Schema-first
 * entities (Prisma) resolve too: when exactly one `User` is defined, the
 * `@prisma/client` import collapses to that schema node's id.
 *
 * Infrastructure sources (ORM contexts, generated schema/catalog holders like
 * jOOQ's `Tables`/`Sps`, repository facades) are dropped via a fan-out cap —
 * see {@link MAX_ENTITIES_PER_MODEL}. Without it, those classes — which expose
 * one field per table — attach themselves to every entity and bury the real
 * model links.
 */
export function linkEntityModels(entityGraph: EntityGraph, classGraph: ClassGraph): void {
  if (entityGraph.nodes.length === 0 || classGraph.edges.length === 0) return;

  const nodeById = new Map(classGraph.nodes.map((n) => [n.id, n]));
  const entityIds = new Set(entityGraph.nodes.map((n) => n.id));

  // targetEntityId → (modelId → merged EntityModelRef)
  const byTargetId = new Map<string, Map<string, EntityModelRef>>();
  // modelId → set of distinct entity ids it references (for the fan-out cap).
  const fanOut = new Map<string, Set<string>>();
  for (const e of classGraph.edges) {
    // Only edges that land on an entity matter here.
    if (!entityIds.has(e.target)) continue;
    const kinds = (Object.keys(e.byKind) as TypeUsageKind[]).filter((k) => DATA_KINDS.has(k));
    if (kinds.length === 0) continue;

    const src = nodeById.get(e.source);
    // Only real models reference an entity: skip file/external sources and
    // other entities (entity↔entity links already render as ER relationships).
    if (!src || src.isFile || src.isExternal || src.isEntity) continue;

    const seen = fanOut.get(src.id) ?? new Set<string>();
    seen.add(e.target);
    fanOut.set(src.id, seen);

    let byModel = byTargetId.get(e.target);
    if (!byModel) {
      byModel = new Map();
      byTargetId.set(e.target, byModel);
    }
    let ref = byModel.get(src.id);
    if (!ref) {
      ref = { id: src.id, name: src.name, filePath: src.filePath, isInterface: src.isInterface, kinds: [], count: 0 };
      byModel.set(src.id, ref);
    }
    for (const k of kinds) {
      if (!ref.kinds.includes(k)) ref.kinds.push(k);
      ref.count += e.byKind[k] ?? 0;
    }
    ref.kinds.sort();
  }

  for (const node of entityGraph.nodes) {
    const byModel = byTargetId.get(node.id);
    if (!byModel || byModel.size === 0) continue;
    // Drop infrastructure sources that reference too many distinct entities.
    const models = [...byModel.values()].filter(
      (m) => (fanOut.get(m.id)?.size ?? 0) <= MAX_ENTITIES_PER_MODEL,
    );
    if (models.length === 0) continue;
    node.referencingModels = models.sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    );
  }
}

/** Lowercase + de-pluralized match keys for a table/entity name — mirrors the
 *  keying used by `attributeDataAccessToSymbols` so the two stay in sync. */
/**
 * Case-insensitive match keys for an entity/table name: the name itself, a
 * singular variant, and — because a `CustomerEntity` class models the
 * `customer` table while repository-derived access names drop the suffix —
 * the `entity`-suffix-stripped variants. Shared by node dedupe here and by
 * `attributeDataAccessToSymbols` (data-access-graph.ts) so an access matches
 * a real node instead of spawning a duplicate "inferred" one.
 */
export function tableMatchKeys(name: string): string[] {
  const base = name.split("::").pop()!.toLowerCase();
  const keys = [base];
  if (base.endsWith("s") && base.length > 1) keys.push(base.slice(0, -1));
  if (base.endsWith("entity") && base.length > "entity".length) {
    const stripped = base.slice(0, -"entity".length);
    keys.push(stripped);
    if (stripped.endsWith("s") && stripped.length > 1) keys.push(stripped.slice(0, -1));
  }
  return keys;
}

/**
 * Add ER nodes for database tables that are *referenced* by data-access calls
 * but never modeled as an ORM entity — e.g. CodeIgniter/knex/raw-SQL projects
 * where `$this->db->get('orders')` names a table that has no entity class (CI
 * tables are bare string literals; there's no schema to extract). Without this
 * the Data Model tab is empty and every such access is `entityMatched:false`.
 *
 * Language-agnostic: it reads `ds.entity` off any plugin's `database` data
 * sources for nodes, and query-builder JOIN relations (orm `"ci-query"`,
 * emitted by the PHP plugin) for edges. Deduped against existing nodes/edges
 * with the SAME lowercase+singular match the access attribution uses, so an ORM
 * project — whose tables already have entity classes — gains nothing and stays
 * byte-identical. Synthetic nodes carry no columns (the schema isn't known) and
 * `orm:"inferred"` so the report can mark them as derived. Mutates `graph`.
 */
export function synthesizeReferencedTableEntities(
  analyses: FileAnalysis[],
  graph: EntityGraph,
): void {
  // Keys already represented by a node — seeded from real entities, then grown
  // as we synthesize so a singular/plural variant never makes a second node.
  const covered = new Set<string>();
  for (const n of graph.nodes) for (const k of tableMatchKeys(n.name)) covered.add(k);

  for (const a of analyses) {
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "database") continue;
      const table = ds.entity?.trim();
      if (!table) continue;
      // A real table is a bare SQL identifier. This rejects framework/template
      // noise that leaks into `entity` from dynamic-language data sources
      // (`$el`, `$backdrop` from Vue refs), keeping the Data Model to real tables.
      if (!/^[A-Za-z_]\w*$/.test(table)) continue;
      const keys = tableMatchKeys(table);
      if (keys.some((k) => covered.has(k))) continue; // matches a real or earlier node
      for (const k of keys) covered.add(k);
      graph.nodes.push({
        id: `inferred::${keys[0]}`,
        name: table,
        orm: "inferred",
        kind: "entity",
        filePath: a.filePath,
        columns: [],
        line: ds.line,
      });
    }
  }

  // Edges from query-builder JOINs: connect the two table nodes a JOIN relates.
  // Resolved against the just-added (+ real) nodes; deduped by unordered pair so
  // a FK joined across many queries yields one relationship. Source/target are
  // sorted by id with cardinalities tracking the orientation, mirroring
  // buildEntityGraph so the diagram renders these identically to declared edges.
  const idByKey = new Map<string, string>();
  for (const n of graph.nodes) for (const k of tableMatchKeys(n.name)) {
    if (!idByKey.has(k)) idByKey.set(k, n.id);
  }
  const resolveId = (name: string): string | null => {
    for (const k of tableMatchKeys(name)) {
      const id = idByKey.get(k);
      if (id) return id;
    }
    return null;
  };
  const edgeKey = (x: string, y: string): string => (x < y ? `${x}\0${y}` : `${y}\0${x}`);
  const haveEdge = new Set(graph.edges.map((e) => edgeKey(e.source, e.target)));

  for (const a of analyses) {
    for (const r of a.entityRelations ?? []) {
      if (r.orm !== "ci-query") continue;
      const fromId = resolveId(r.fromEntity);
      const toId = resolveId(r.toEntity);
      if (!fromId || !toId) continue; // a table the JOIN names has no node
      const key = edgeKey(fromId, toId);
      if (haveEdge.has(key)) continue;
      haveEdge.add(key);
      // `from` is the FK-owning (many) side; keep cardinalities aligned to the
      // id-sorted source/target orientation.
      const fromIsSource = fromId <= toId;
      graph.edges.push({
        source: fromIsSource ? fromId : toId,
        target: fromIsSource ? toId : fromId,
        sourceCardinality: fromIsSource ? "many" : "one",
        targetCardinality: fromIsSource ? "one" : "many",
        fields: [],
        foreignKey: r.foreignKey ?? null,
        orm: "inferred",
        confidence: "INFERRED",
        selfRef: fromId === toId,
      });
    }
  }
}
