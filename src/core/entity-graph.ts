import type {
  FileAnalysis,
  EntityGraph,
  EntityGraphNode,
  EntityGraphEdge,
  EntityGraphColumn,
  EntityModelRef,
  ClassGraph,
  ClassInfo,
  PropertyInfo,
  EntityRelation,
  TypeUsageKind,
  Confidence,
} from "../types/analysis.js";
import { byOrdinal } from "./ordinal.js";
import { isTestFile } from "./test-file-detector.js";
import { isApiContractLanguage } from "../extractors/registry.js";

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
  "index", "sequence", "schema", "type", "abstract",
]);

/**
 * An entity base that maps no table of its own (JPA `@MappedSuperclass`, an
 * abstract model): no node, its columns are its subclasses'.
 */
const ABSTRACT_ENTITY = "abstract";

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
  // An API description's schema of the same name is no base class of code: each side inherits within itself.
  const byBare = new Map<string, Array<{ c: ClassInfo; contract: boolean; test: boolean; filePath: string }>>();
  const testFile = new Map<string, boolean>();
  for (const a of analyses) {
    const contract = isApiContractLanguage(a.language);
    const test = isTestFile(a.filePath, a.language);
    testFile.set(a.filePath, test);
    for (const c of a.classes ?? []) {
      const b = bareName(c.name);
      if (!b) continue;
      const arr = byBare.get(b) ?? [];
      arr.push({ c, contract, test, filePath: a.filePath });
      byBare.set(b, arr);
    }
  }
  const isEntity = (c: { decorators?: string[] }) => (c.decorators ?? []).includes("entity");

  let changed = true;
  let guard = 0;
  while (changed && guard++ < 50) {
    changed = false;
    for (const a of analyses) {
      const contract = isApiContractLanguage(a.language);
      for (const c of a.classes ?? []) {
        if (isEntity(c)) continue;
        // A schema object ON a table (an index, a sequence) names the table, never a subclass of it.
        if ((c.decorators ?? []).some((d) => d === "index" || d === "sequence" || d === "schema")) continue;
        const parentName = bareName(c.extends);
        if (!parentName) continue;
        // `import com.example.league.api.Address;` names WHICH `Address` is extended: an entity of
        // that name in another package is not it.
        const imported = (a.imports ?? []).find((i) => i.specifiers?.includes(parentName) && /^[\w$]+(?:\.[\w$]+)+$/.test(i.source) && i.source.endsWith(`.${parentName}`));
        const importedPath = imported ? imported.source.replace(/\./g, "/") : null;
        const hit = (byBare.get(parentName) ?? []).find((p) => p.contract === contract && isEntity(p.c) &&
          (!importedPath || p.filePath.replace(/\.\w+$/, "").endsWith(importedPath)));
        // A test's subclass of a production model (`class StubClub extends Club` to reach
        // its protected hooks) is a test double, not another model.
        if (!hit || (testFile.get(a.filePath) && !hit.test)) continue;
        const parent = hit.c;
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

/**
 * Propagate an STI base class's relations down to its subclasses. In
 * single-table inheritance (Rails STI, JPA `@Inheritance`, EF TPH, Sequel STI) a
 * subclass IS-A its parent and shares the parent's table AND associations. The
 * engine already copies the shared COLUMNS down (each plugin's schema join), but
 * the relations stay on the base — so every subclass node renders as an
 * unconnected island in the Data Model view even though `ChangeRequest`'s
 * `belongs_to :employee` applies to each of its STI children. This closes that
 * gap symmetrically with the column inheritance: for every entity that
 * (transitively) extends another entity, re-home a copy of each ancestor
 * relation onto the subclass so it participates in the same relationships.
 *
 * Additive only — never removes or rewrites a declared relation; a relation the
 * subclass already declares (an override) wins and is not duplicated. Inherited
 * copies are marked `INFERRED`. Language-agnostic; must run on the reconciled
 * (post-`reconcileEntityInheritance`) analyses so cross-file STI children are
 * already tagged entities, and before `buildEntityGraph`.
 */
export function propagateStiRelations(analyses: FileAnalysis[]): void {
  const isEntity = (c: ClassInfo) => (c.decorators ?? []).includes("entity");

  // Index entity classes by bare name (STI parents are named by bare superclass).
  const entityByBare = new Map<string, ClassInfo>();
  for (const a of analyses) {
    for (const c of a.classes ?? []) {
      if (!isEntity(c)) continue;
      const b = bareName(c.name);
      if (b && !entityByBare.has(b)) entityByBare.set(b, c);
    }
  }

  // Snapshot each entity's ORIGINAL declared relations by bare `fromEntity`, so
  // propagation reads a base's own relations, never ones added by this pass.
  const ownRelations = new Map<string, EntityRelation[]>();
  for (const a of analyses) {
    for (const r of a.entityRelations ?? []) {
      const from = bareName(r.fromEntity);
      if (!from) continue;
      (ownRelations.get(from) ?? ownRelations.set(from, []).get(from)!).push(r);
    }
  }

  /** Bare names of every entity ancestor of `bare`, nearest first (cycle-safe). */
  const ancestorsOf = (bare: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>([bare]);
    let cur = entityByBare.get(bare);
    while (cur) {
      const parent = bareName(cur.extends);
      if (!parent || seen.has(parent)) break;
      seen.add(parent);
      chain.push(parent);
      cur = entityByBare.get(parent);
    }
    return chain;
  };

  // An association's identity is its field name (redefining `belongs_to :owner`
  // overrides the base regardless of target), so dedup by `fromField`; fall back
  // to target+cardinality for the rare field-less relation.
  const relKey = (r: EntityRelation) =>
    r.fromField ? `f:${r.fromField.toLowerCase()}` : `t:${(r.toEntity ?? "").toLowerCase()}|${r.cardinality}`;

  for (const a of analyses) {
    for (const c of a.classes ?? []) {
      if (!isEntity(c)) continue;
      const bare = bareName(c.name);
      if (!bare) continue;
      const ancestors = ancestorsOf(bare);
      if (ancestors.length === 0) continue;

      // Seed the dedup set with the subclass's OWN relations so an override wins.
      const have = new Set<string>((ownRelations.get(bare) ?? []).map(relKey));
      const additions: EntityRelation[] = [];
      for (const anc of ancestors) {
        for (const r of ownRelations.get(anc) ?? []) {
          const k = relKey(r);
          if (have.has(k)) continue;
          have.add(k);
          additions.push({ ...r, fromEntity: bare, confidence: "INFERRED" });
        }
      }
      if (additions.length > 0) a.entityRelations = [...(a.entityRelations ?? []), ...additions];
    }
  }
}

/**
 * Build the ER graph: one node per ORM entity, table or enum class, one edge
 * per `EntityRelation`, resolved by entity name across files.
 *
 * Tables that are only referenced by raw SQL get synthesized nodes so a query
 * has something to point at; relations inherited through `extends` were
 * already copied onto subclasses by `propagateInheritedRelations`.
 *
 * @param analyses - Every file analysis
 * @returns Nodes and edges in a stable order
 */
export function buildEntityGraph(analyses: FileAnalysis[]): EntityGraph {
  const nodes = new Map<string, EntityGraphNode>();
  const nameToIds = new Map<string, string[]>();
  const projectOf = new Map<string, string>();

  // An API contract split into several documents (one spec, then one per tag
  // group) repeats each schema in each: one node per name and shape in a sub-project.
  const contractSchemas = new Set<string>();

  // Tables a schema script declares (CREATE TABLE), as opposed to ORM entities.
  const ddlIds = new Set<string>();

  // A repository whose code declares its data model: the API descriptions'
  // schemas are request and response shapes, not more of the model (a spec-only
  // repository keeps them — they are all the model it states).
  const modelled = analyses.some((a) => !isApiContractLanguage(a.language) && (a.classes ?? []).some((c) => (c.decorators ?? []).includes("entity") || (c.decorators ?? []).includes("table")));

  // Table-less entity bases by bare name, and the chain of them above a class.
  const abstractBases = new Map<string, ClassInfo>();
  for (const a of analyses) {
    if (isApiContractLanguage(a.language)) continue;
    for (const c of a.classes ?? []) {
      const b = bareName(c.name);
      if (b && (c.decorators ?? []).includes(ABSTRACT_ENTITY) && (c.decorators ?? []).includes("entity") && !abstractBases.has(b)) abstractBases.set(b, c);
    }
  }
  const abstractAncestors = (cls: ClassInfo): ClassInfo[] => {
    const out: ClassInfo[] = [];
    const seen = new Set<string>();
    let parent = bareName(cls.extends?.replace(/<.*$/s, "") ?? null);
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const base = abstractBases.get(parent);
      if (!base) break;
      out.push(base);
      parent = bareName(base.extends?.replace(/<.*$/s, "") ?? null);
    }
    return out;
  };

  // ── Pass 1: nodes (entities / tables / enums) ──
  for (const a of analyses) {
    const contract = isApiContractLanguage(a.language);
    if (contract && modelled) continue;
    for (const cls of a.classes ?? []) {
      const decs = cls.decorators ?? [];
      const isEntity = decs.includes("entity") || decs.includes("table");
      const isEnum = decs.includes("enum");
      if (!isEntity && !isEnum) continue;
      if (contract) {
        const shape = `${a.projectId ?? "root"}\0${cls.name}\0${(cls.properties ?? []).map((p) => `${p.name}:${p.type ?? ""}`).join(",")}`;
        if (contractSchemas.has(shape)) continue;
        contractSchemas.add(shape);
      }

      const id = `${a.filePath}::${cls.name}`;
      if (nodes.has(id)) continue;
      projectOf.set(id, a.projectId ?? "root");
      if (decs.includes("table") && !decs.includes("entity")) ddlIds.add(id);

      // The ORM tag is the decorator our entity extractor places immediately
      // after the lowercase `entity`/`table`/`enum` marker (e.g. ["Entity()",
      // "entity", "typeorm"]). Picking "first non-structural" would wrongly grab
      // the language's own raw decorator (`Entity()`, `ORM\Entity`).
      const markerIdx = decs.findIndex((d) => d === "entity" || d === "table" || d === "enum");
      const next = markerIdx >= 0 ? decs[markerIdx + 1] : undefined;
      const orm = (next && !STRUCTURAL.has(next)) ? next : (decs.includes("table") ? "sql" : null);
      if (isEntity && decs.includes(ABSTRACT_ENTITY)) continue;
      const toColumn = (p: PropertyInfo): EntityGraphColumn => ({
        name: p.name,
        ...(p.column ? { column: p.column } : {}),
        type: p.type,
        isPrimaryKey: p.primaryKey ?? isPrimaryKey(p.name, p.type),
      });
      const columns: EntityGraphColumn[] = (cls.properties ?? []).map(toColumn);
      // The columns a table-less base maps (an inherited `@Id`) are this table's.
      const own = new Set(columns.map((c) => c.name));
      for (const base of abstractAncestors(cls)) {
        for (const p of base.properties ?? []) {
          if (own.has(p.name)) continue;
          own.add(p.name);
          columns.push(toColumn(p));
        }
      }

      nodes.set(id, {
        id,
        name: cls.name,
        ...(cls.tableName ? { table: cls.tableName } : {}),
        orm,
        kind: isEnum ? "enum" : "entity",
        filePath: a.filePath,
        columns,
        line: cls.line,
      });
      // Index by full name AND bare last segment so a relation whose target is
      // written bare (`class_name: 'League::MatchReport'` → "MatchReport")
      // still resolves to a namespaced entity node.
      // A schema script's table answers its bare name too: `REFERENCES Clubs(Id)`
      // reaches `CREATE TABLE dbo.Clubs` (the default schema is not written).
      const ddlBare = ddlIds.has(id) ? [cls.name.split(".").pop()!] : [];
      for (const key of new Set([cls.name, cls.name.split("::").pop()!, ...ddlBare])) {
        const arr = nameToIds.get(key) ?? [];
        if (!arr.includes(id)) arr.push(id);
        nameToIds.set(key, arr);
      }
    }
  }

  /**
   * Resolve a relation's target entity name to a node id: the same file, then
   * the one entity of that name in the declaring file's sub-project (or the
   * one of the relation's ORM there), then the one in the whole repository.
   * Several candidates and no way to choose is a refusal: a JPA `Comment`
   * used to attach to whichever `Comment` came first — another service's
   * Django model.
   */
  function resolveTarget(name: string, fromFile: string, fromProject: string, orm?: string | null): string | null {
    const ids = nameToIds.get(name);
    if (!ids || ids.length === 0) return null;
    // In the same file, the one of that name — or, by a bare name, the one table it can be
    // (`dbo.Clubs` and `sales.Clubs` in one script leave `Clubs` undecided).
    const sameFile = ids.filter((id) => id.startsWith(`${fromFile}::`));
    if (sameFile.length === 1) return sameFile[0]!;
    if (sameFile.length > 1) {
      const exact = sameFile.filter((id) => nodes.get(id)?.name === name);
      return exact.length === 1 ? exact[0]! : null;
    }
    const pick = (cands: string[]): string | null => {
      if (cands.length === 1) return cands[0]!;
      if (cands.length > 1 && orm) {
        const sameOrm = cands.filter((id) => nodes.get(id)?.orm === orm);
        if (sameOrm.length === 1) return sameOrm[0]!;
      }
      return null;
    };
    const local = ids.filter((id) => projectOf.get(id) === fromProject);
    if (local.length > 0) return pick(local);
    return pick(ids);
  }

  foldMappedTables(nodes, nameToIds, ddlIds, projectOf);

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
      const fromProject = a.projectId ?? "root";
      const srcId = nodes.has(sameFileSrc) ? sameFileSrc : resolveTarget(r.fromEntity, a.filePath, fromProject, r.orm);
      if (!srcId) continue;
      const tgtId = resolveTarget(r.toEntity, a.filePath, fromProject, r.orm);
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
    nodes: [...nodes.values()].sort((x, y) => byOrdinal(x.id, y.id)),
    edges: edges.sort((x, y) => byOrdinal(x.source, y.source) || byOrdinal(x.target, y.target)),
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
      (a, b) => b.count - a.count || byOrdinal(a.name, b.name),
    );
  }
}

/** Lowercase + de-pluralized match keys for a table/entity name — mirrors the
 *  keying used by `attributeDataAccessToSymbols` so the two stay in sync. */
/**
 * Case-insensitive match keys for an entity/table name: the name itself, a
 * singular variant, and — because a `CustomerEntity` class models the
 * `customer` table while repository-derived access names drop the suffix —
 * the `entity`-suffix-stripped variants (and `entity`-prefix-stripped, for the
 * `EntityCustomer` convention). Shared by node dedupe here and by
 * `attributeDataAccessToSymbols` (data-access-graph.ts) so an access matches
 * a real node instead of spawning a duplicate "inferred" one.
 */
/** A node's match keys: its name's and, where the ORM names one, its physical table's. */
/**
 * A table a schema script declares and the ORM entity of its sub-project that
 * maps it (`CREATE TABLE users` and `#[diesel(table_name = users)] struct User`)
 * are one node: the entity's. The table's name then resolves to the entity, so
 * a foreign key the script states joins the entity. An entity matches by the
 * table it names, else — when it names none — by its own name's table keys;
 * a table two entities map stays a table.
 */
function foldMappedTables(nodes: Map<string, EntityGraphNode>, nameToIds: Map<string, string[]>, ddlIds: Set<string>, projectOf: Map<string, string>): void {
  if (ddlIds.size === 0 || ddlIds.size === nodes.size) return;
  const entitiesByProject = new Map<string, EntityGraphNode[]>();
  for (const n of nodes.values()) {
    if (ddlIds.has(n.id) || n.kind !== "entity") continue;
    const p = projectOf.get(n.id)!;
    (entitiesByProject.get(p) ?? entitiesByProject.set(p, []).get(p)!).push(n);
  }
  for (const id of ddlIds) {
    const table = nodes.get(id)!;
    const name = table.name.split(".").pop()!.toLowerCase();
    const keys = new Set(tableMatchKeys(table.name));
    let maps = (entitiesByProject.get(projectOf.get(id)!) ?? []).filter((e) =>
      e.table ? e.table.split(".").pop()!.toLowerCase() === name : tableMatchKeys(e.name).some((k) => keys.has(k)),
    );
    // Migrations kept in a crate or module of their own: the one entity anywhere that names the table outright.
    if (maps.length === 0) {
      maps = [...entitiesByProject.values()].flat().filter((e) =>
        e.table ? e.table.split(".").pop()!.toLowerCase() === name : e.name.split(/::|\./).pop()!.toLowerCase() === name,
      );
    }
    if (maps.length !== 1) continue;
    nodes.delete(id);
    for (const [key, ids] of nameToIds) {
      const at = ids.indexOf(id);
      if (at < 0) continue;
      const next = ids.filter((x) => x !== id);
      if (!next.includes(maps[0]!.id)) next.splice(at, 0, maps[0]!.id);
      nameToIds.set(key, next);
    }
  }
}

export function nodeMatchKeys(node: { name: string; table?: string }): string[] {
  return node.table ? [...new Set([...tableMatchKeys(node.name), ...tableMatchKeys(node.table)])] : tableMatchKeys(node.name);
}

/**
 * Match key → the node it names, over every node: names first, then the
 * tables ORMs map them to, so an entity's own name always beats another
 * entity's table (a migration's `tasksMigration2019` copy mapped to `tasks`
 * must not take `Task`'s key). Within each pass the first node wins.
 */
export function nodeKeyIndex<T extends { name: string; table?: string }, V>(nodes: readonly T[], value: (n: T) => V): Map<string, V> {
  const out = new Map<string, V>();
  for (const n of nodes) for (const k of tableMatchKeys(n.name)) if (!out.has(k)) out.set(k, value(n));
  for (const n of nodes) if (n.table) for (const k of tableMatchKeys(n.table)) if (!out.has(k)) out.set(k, value(n));
  return out;
}

export function tableMatchKeys(name: string): string[] {
  // The last segment of a namespaced name — Ruby `Ns::Model`, an Elixir module
  // `Plausible.Site`, a schema-qualified table `shop.orders` — is how code
  // names it (`Repo.get(Site, id)`, `FROM orders`).
  const base = name.split(/::|\./).pop()!.toLowerCase();
  const keys = [base];
  if (base.endsWith("s") && base.length > 1) keys.push(base.slice(0, -1));
  // `AppUserProgresses` → appuserprogress, `Matches` → match, `Categories` → category.
  if (/(?:ss|x|ch|sh|z)es$/.test(base)) keys.push(base.slice(0, -2));
  if (base.endsWith("ies") && base.length > 3) keys.push(`${base.slice(0, -3)}y`);
  const affixStripped: string[] = [];
  if (base.endsWith("entity") && base.length > "entity".length) affixStripped.push(base.slice(0, -"entity".length));
  if (base.startsWith("entity") && base.length > "entity".length) affixStripped.push(base.slice("entity".length));
  for (const stripped of affixStripped) {
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
  for (const n of graph.nodes) for (const k of nodeMatchKeys(n)) covered.add(k);
  // A table some schema script drops or renames away (the old `match_reports`, moved into one combined
  // table and dropped) is the schema's history: if the schema still had it, a script would create it.
  const removed = new Set(
    analyses.flatMap((a) => (a.schemaOps ?? []).filter((o) => o.op === "drop-table" || o.op === "rename-table")).map((o) => o.table.split(".").pop()!.toLowerCase()),
  );

  for (const a of analyses) {
    // A name only a test queries (a mocked `jdbcTemplate`'s argument type) is no table of the schema.
    if (isTestFile(a.filePath, a.language)) continue;

    // A table the file's own schema changes create, rename or drop (a migration copying
    // `cars` into `cars_new`, then renaming it) is the schema's to show, as it ends.
    const ownSchema = new Set(
      (a.schemaOps ?? []).filter((o) => /table$/.test(o.op)).flatMap((o) => [o.table, ...(o.op === "rename-table" && o.to ? [o.to] : [])]).map((n) => n.split(".").pop()!.toLowerCase()),
    );
    for (const ds of a.dataSources ?? []) {
      if (ds.kind !== "database") continue;
      const table = ds.entity?.trim();
      if (!table || ownSchema.has(table.toLowerCase()) || removed.has(table.toLowerCase())) continue;
      // A real table is a bare SQL identifier. This rejects framework/template
      // noise that leaks into `entity` from dynamic-language data sources
      // (`$el`, `$backdrop` from Vue refs), keeping the Data Model to real tables.
      if (!/^[A-Za-z_]\w*$/.test(table)) continue;
      const keys = tableMatchKeys(table);
      if (keys.some((k) => covered.has(k))) continue; // matches a real or earlier node
      for (const k of keys) covered.add(k);
      graph.nodes.push({
        // `<file>::<symbol>` — the SAME id shape every real entity node uses.
        // The on-disk element registry stores only the id and reconstructs
        // `name` and `filePath` by splitting it (element-registry.ts), so an
        // id like `inferred::<key>` came back as the table `inferred` with a
        // lowercased match key for a name and no openable location. Keying on
        // the file that queries the table restores all three.
        id: `${a.filePath}::${table}`,
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
  const idByKey = nodeKeyIndex(graph.nodes, (n) => n.id);
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
