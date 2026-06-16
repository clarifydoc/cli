import type { EntityRelation, FileAnalysis, Language } from "../../types/analysis.js";
import { EntityExtractor, type EntityExtractResult } from "./base.js";
import { JavaScriptEntityExtractor } from "../plugins/javascript/entities.js";
import { PythonEntityExtractor } from "../plugins/python/entities.js";
import { JavaKotlinEntityExtractor } from "../plugins/java-kotlin/entities.js";
import { CSharpEntityExtractor } from "../plugins/csharp/entities.js";
import { GoEntityExtractor } from "../plugins/go/entities.js";
import { RustEntityExtractor } from "../plugins/rust/entities.js";
import { PhpEntityExtractor } from "../plugins/php/entities.js";
import { RubyEntityExtractor } from "../plugins/ruby/entities.js";

/** All registered language entity extractors. */
const extractors: EntityExtractor[] = [
  new JavaScriptEntityExtractor(),
  new PythonEntityExtractor(),
  new JavaKotlinEntityExtractor(),
  new CSharpEntityExtractor(),
  new GoEntityExtractor(),
  new RustEntityExtractor(),
  new PhpEntityExtractor(),
  new RubyEntityExtractor(),
];

const extractorMap = new Map<Language, EntityExtractor>();
for (const ex of extractors) {
  for (const lang of ex.languages) extractorMap.set(lang, ex);
}

/**
 * Extract ORM entities + relations from a file. Returns empty for languages
 * with no entity extractor (Prisma is handled separately via its regex spec's
 * `extractClasses`/`extractEntityRelations` hooks).
 */
export function extractEntities(
  analysis: FileAnalysis,
  sourceText: string,
  language: Language,
): EntityExtractResult {
  const ex = extractorMap.get(language);
  if (!ex) return { entities: [], relations: [] };
  const lines = sourceText.split("\n");
  return ex.extract({ analysis, sourceText, lines });
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
        if (!existing.decorators.includes(d)) existing.decorators.push(d);
      }
      // jOOQ generated tables list EVERY column precisely via `createField`, so
      // those columns are authoritative — REPLACE, dropping the general class
      // extractor's noise (`serialVersionUID`, the static table constant). For
      // other ORMs the extractor can under-capture (e.g. unannotated fields), so
      // UNION to stay safe.
      if (e.decorators.includes("jooq") && e.properties.length > 0) {
        existing.properties = e.properties;
      } else {
        const haveProps = new Set(existing.properties.map((p) => p.name));
        for (const p of e.properties) {
          if (!haveProps.has(p.name)) existing.properties.push(p);
        }
      }
      for (const im of e.implements) {
        if (!existing.implements.includes(im)) existing.implements.push(im);
      }
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
