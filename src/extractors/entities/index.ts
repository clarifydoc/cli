import type { EntityRelation, FileAnalysis, Language } from "../../types/analysis.js";
import { splitLines } from "../shared/source-lines.js";
import { SYNTHETIC_ENTITY, type EntityExtractor, type EntityExtractResult } from "./base.js";
import { pluginFor, allPluginMetas } from "../registry.js";

const EMPTY_RESULT: EntityExtractResult = { entities: [], relations: [] };

/**
 * Cheap per-language pre-scan: a file produces ORM entities only if its source
 * contains one of these markers. When none match we skip the (relatively
 * expensive) logical-line splitting + per-ORM regex passes entirely — a big win
 * on non-ORM codebases (most frontend files). Each pattern is a SUPERSET of what
 * the corresponding extractor can detect, so gating on it is output-preserving;
 * a missed marker would silently drop entities, so the regenerated fixtures (which
 * exercise every ORM) are the completeness check.
 */
const JS_MARKERS =
  /@(?:Entity|Embeddable|Column|Property|PrimaryGeneratedColumn|PrimaryColumn|ObjectIdColumn|CreateDateColumn|UpdateDateColumn|DeleteDateColumn|VersionColumn|OneToMany|ManyToOne|OneToOne|ManyToMany|JoinColumn|JoinTable|Enum|Embedded|RelationId)\b|\bsequelize\b|\bDataTypes\b|\bmongoose\b|\bnew\s+(?:[\w$]+\.)?Schema\s*\(|\b(?:pg|mysql|sqlite|singlestore)Table\s*\(/;
const JAVA_MARKERS =
  /@(?:Entity|Table|MappedSuperclass|Column|Id|ManyToOne|OneToMany|OneToOne|ManyToMany|JoinColumn|JoinTable|Embeddable|Embedded|ElementCollection|Inheritance|DiscriminatorColumn|DiscriminatorValue|MappedCollection)\b|\bTableImpl\b|\bcreateField\s*\(|\bcreateForeignKey\b/;
const LANGUAGE_MARKERS: Partial<Record<Language, RegExp>> = {
  typescript: JS_MARKERS,
  javascript: JS_MARKERS,
  java: JAVA_MARKERS,
  kotlin: JAVA_MARKERS,
  python:
    /\bmodels\.(?:Model|[A-Z]\w*Field|ForeignKey|OneToOneField|ManyToManyField)|__tablename__|\bmapped_column\b|\bMapped\s*\[|\brelationship\s*\(|\bColumn\s*\(|\bdb\.Entity\b|\bForeignKeyField\b|\bDeclarativeBase\b|\bDeferredForeignKey\b|\bfields\.(?:ForeignKeyField|OneToOneField|ManyToManyField)|\bPrimaryKey\s*\(|\bRequired\s*\(|\bDeclarative_base\b|\bdeclarative_base\b/,
  csharp:
    /\bDbSet\s*<|\[\s*(?:Table|Column|Key|ForeignKey|Class)\b|\bmodelBuilder\b|\.HasOne\s*\(|\.HasMany\s*\(|\.WithMany\s*\(|\b(?:Create|Rename|Delete)\.Table/,
  go: /\bgorm\b|gorm:"|\bent\.Schema\b|\bRegisterModel\s*\(|orm:"/,
  dart: /\bextends\s+Table\b|@[cC]ollection\b|@[eE]ntity\b|@HiveType\b|\bIsarLinks?</,
  rust: /\btable!\s*\{|\bdiesel\b|\bQueryable\b|\bInsertable\b|\bDeriveEntityModel\b|\bsea_orm\b/,
  php:
    /\bextends\s+(?:Model|Authenticatable|Pivot)\b|@ORM\\|#\[\s*ORM\\|->\s*(?:hasMany|belongsTo|hasOne|belongsToMany|morph\w*|hasManyThrough|hasOneThrough)\s*\(|\b(?:hasMany|belongsTo|hasOne|belongsToMany)\s*\(|->\s*join\s*\(\s*['"]|\bSchema::(?:create|table|drop|dropIfExists|rename)\s*\(/,
  sql: /\b(?:CREATE|ALTER|DROP|RENAME)\s+(?:(?:GLOBAL\s+)?(?:TEMPORARY|TEMP|UNLOGGED)\s+)?TABLE\b/i,
  swift: /@Model\b|\bNSManagedObject\b/,
  ruby:
    /<\s*(?:ApplicationRecord|ActiveRecord::Base)\b|\bhas_many\b|\bbelongs_to\b|\bhas_one\b|\bhas_and_belongs_to_many\b|self\.table_name|ActiveRecord::Schema\b/,
};

/**
 * Extract ORM entities + relations from a file. Returns empty for languages
 * with no entity extractor (Prisma is handled separately via its regex spec's
 * `extractClasses`/`extractEntityRelations` hooks), and for files that contain
 * none of their language's ORM markers (the common case — skipped cheaply).
 */
export function extractEntities(
  analysis: FileAnalysis,
  sourceText: string,
  language: Language,
): EntityExtractResult {
  const ex = pluginFor(language)?.entities;
  if (!ex) return EMPTY_RESULT;
  const markers = LANGUAGE_MARKERS[language];
  if (markers && !markers.test(sourceText)) return EMPTY_RESULT;
  const lines = splitLines(sourceText);
  return ex.extract({ analysis, sourceText, lines });
}

/**
 * Run every entity extractor's project-level reconciliation pass over the full
 * file set. Lets a language plugin perform cross-file joins it cannot do
 * per-file (e.g. Rails attaching `db/schema.rb` columns to its models). Each
 * extractor runs once; non-overriding extractors are no-ops. Core calls this —
 * it never reaches into a language-specific reconciler itself.
 */
export function reconcileProjectEntities(analyses: FileAnalysis[]): void {
  // Family plugins share ONE extractor instance across member metas, so the
  // identity set runs each extractor exactly once.
  const seen = new Set<EntityExtractor>();
  for (const meta of allPluginMetas()) {
    const ex = meta.entities;
    if (!ex || seen.has(ex)) continue;
    seen.add(ex);
    ex.reconcileProject(analyses);
  }
}

/**
 * Merge extracted entities into `analysis.classes` by name. If a class with the
 * entity's name already exists (the general class extractor found it), enrich
 * it — union decorators, add missing columns, union related names. Otherwise
 * add the entity as a new node (call-based models with no class declaration).
 */
export function mergeEntities(analysis: FileAnalysis, result: EntityExtractResult): void {
  for (const e of result.entities) {
    const existing = analysis.classes.find((c) => c.name === e.name);
    if (existing) {
      for (const d of e.decorators) {
        // SYNTHETIC_ENTITY says "no declaration backs this" — a declaration
        // clearly does back this one, and inheriting the marker would drop the
        // real class from the class graph.
        if (d === SYNTHETIC_ENTITY) continue;
        if (!existing.decorators.includes(d)) existing.decorators.push(d);
      }
      // jOOQ generated tables list EVERY column precisely via `createField`, so
      // those columns are authoritative — REPLACE, dropping the general class
      // extractor's noise (`serialVersionUID`, the static table constant). For
      // other ORMs the extractor can under-capture (e.g. unannotated fields), so
      // UNION to stay safe.
      // SwiftData / Core Data models say which properties are stored (computed and
      // @Transient ones are not) — authoritative too.
      if ((e.decorators.includes("jooq") || e.decorators.includes("swiftdata") || e.decorators.includes("coredata")) && e.properties.length > 0) {
        existing.properties = e.properties;
      } else {
        const have = new Map(existing.properties.map((p) => [p.name, p]));
        for (const p of e.properties) {
          const known = have.get(p.name);
          if (!known) {
            existing.properties.push(p);
            continue;
          }
          // The extractor's mapping facts land on the member the class extractor found.
          if (p.column && !known.column) known.column = p.column;
          if (p.primaryKey && !known.primaryKey) known.primaryKey = true;
        }
        // A static member (a named-query name, a shared predicate) is no column of a table,
        // unless the entity extractor itself returned it.
        if (!existing.decorators.includes("enum")) {
          const mapped = new Set(e.properties.map((p) => p.name));
          existing.properties = existing.properties.filter((p) => !p.isStatic || mapped.has(p.name));
        }
      }
      for (const im of e.implements) {
        if (!existing.implements.includes(im)) existing.implements.push(im);
      }
      if (e.tableName && !existing.tableName) existing.tableName = e.tableName;
      if (e.routeKey && !existing.routeKey) existing.routeKey = e.routeKey;
    } else {
      analysis.classes.push(e);
    }
  }
  pruneRelationColumns(analysis, result.relations);
}

/**
 * Drop columns that are actually relation *navigation* fields (e.g. a TypeORM
 * `reviews: Review[]` or JPA `author: Author`) — the general class extractor
 * captures them as properties, but they're associations, not scalar columns,
 * and are already represented by `entityRelations` + `implements`. Real foreign
 * KEY columns are kept (a field that backs a relation's `foreignKey`).
 */
function pruneRelationColumns(analysis: FileAnalysis, relations: EntityRelation[]): void {
  const navByEntity = new Map<string, Set<string>>();
  const fkByEntity = new Map<string, Set<string>>();
  for (const r of relations) {
    if (!navByEntity.has(r.fromEntity)) navByEntity.set(r.fromEntity, new Set());
    navByEntity.get(r.fromEntity)!.add(r.fromField);
    if (r.foreignKey) {
      if (!fkByEntity.has(r.fromEntity)) fkByEntity.set(r.fromEntity, new Set());
      fkByEntity.get(r.fromEntity)!.add(r.foreignKey);
    }
  }
  for (const cls of analysis.classes) {
    // Only touch ORM entities (carry the "entity" decorator) so non-entity
    // classes that happen to share a name are never altered.
    if (!cls.decorators.includes("entity")) continue;
    const nav = navByEntity.get(cls.name);
    const fks = fkByEntity.get(cls.name) ?? new Set<string>();
    cls.properties = cls.properties.filter((p) => {
      // ORM config/magic properties are never real columns.
      if (ORM_NON_COLUMN_FIELDS.has(p.name)) return false;
      // Relation navigation fields are associations, not scalar columns
      // (but keep a field that backs a relation's foreign key).
      if (nav && nav.has(p.name) && !fks.has(p.name)) return false;
      return true;
    });
  }
}

/**
 * Property names that ORMs use for configuration/state, never persisted
 * columns (mostly Eloquent's model config). Stripped from entity column lists.
 */
const ORM_NON_COLUMN_FIELDS = new Set<string>([
  // Eloquent model configuration
  "fillable", "guarded", "casts", "hidden", "visible", "appends", "dates",
  "table", "primaryKey", "keyType", "incrementing", "timestamps", "connection",
  "with", "withCount", "touches", "dispatchesEvents", "observables", "perPage",
  "attributes", "dateFormat", "rememberTokenName",
]);

export { EntityExtractor } from "./base.js";
export type { EntityExtractContext, EntityExtractResult } from "./base.js";
