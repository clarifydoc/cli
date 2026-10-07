import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";

/**
 * GORM domain classes (Grails). A class is an entity when it lives under
 * `grails-app/domain/`, carries `@Entity` (`grails.gorm.annotation.Entity`,
 * JPA's on Groovy classes), or declares GORM's static blocks (`mapping`,
 * `constraints`, `hasMany`, `belongsTo`, `hasOne`). Columns are its instance
 * properties; relations come from:
 *
 *  - `static hasMany = [books: Book]`  → one-to-many (`books`)
 *  - `static belongsTo = [author: Author]` / `belongsTo = Author` → many-to-one
 *  - `static hasOne = [profile: Profile]` → one-to-one
 *  - a property typed by another class (`Author author`) → many-to-one,
 *    INFERRED (the type may turn out not to be a domain class)
 *
 * `static mapping = { table 'books' }` names the table (`table:<name>`).
 */
export class GroovyEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["groovy"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const inDomainDir = /(?:^|\/)grails-app\/domain\//.test(ctx.analysis.filePath);
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];
    for (const cls of ctx.analysis.classes) {
      if (cls.kind === "interface" || cls.kind === "enum") continue;
      const body = this.bodyOf(ctx, cls).join("\n");
      const header = ctx.lines.slice(Math.max(0, cls.line - 4), cls.line).join("\n");
      const annotated = /@(?:[\w.]+\.)?Entity\b/.test(header) || cls.decorators.some((d) => /^(?:[\w.]+\.)?Entity\b/.test(d));
      const gormBlocks = /\bstatic\s+(?:mapping|constraints|hasMany|belongsTo|hasOne|mappedBy)\s*=/.test(body);
      if (!inDomainDir && !annotated && !gormBlocks) continue;

      const statics = staticFields(body);
      const table = /\bstatic\s+mapping\s*=\s*\{[\s\S]*?\btable\s*(?:\(\s*)?(?:name\s*:\s*)?['"]([^'"]+)['"]/.exec(body)?.[1];
      const columns: PropertyInfo[] = cls.properties
        .filter((p) => !p.isStatic && !statics.transients.has(p.name) && !/^(?:log|grailsApplication|\w+Service)$/.test(p.name))
        .map((p) => this.column(p.name, p.type));
      entities.push(
        this.entity({
          name: cls.name,
          orm: annotated && /javax\.persistence|jakarta\.persistence/.test(ctx.sourceText) ? "jpa" : "gorm",
          properties: columns,
          extends: cls.extends,
          line: cls.line,
          endLine: cls.endLine,
          extraDecorators: table ? [`table:${table}`] : undefined,
        }),
      );

      const declared = new Set<string>();
      const relate = (fromField: string, toEntity: string, cardinality: EntityRelation["cardinality"], confidence: "EXTRACTED" | "INFERRED") => {
        declared.add(fromField);
        relations.push({ fromEntity: cls.name, fromField, toEntity, cardinality, orm: "gorm", confidence });
      };
      for (const [field, target] of statics.hasMany) relate(field, target, "one-to-many", "EXTRACTED");
      for (const [field, target] of statics.hasOne) relate(field, target, "one-to-one", "EXTRACTED");
      for (const [field, target] of statics.belongsTo) relate(field, target, "many-to-one", "EXTRACTED");
      for (const p of cls.properties) {
        if (p.isStatic || declared.has(p.name) || !p.type || !/^[A-Z]\w*$/.test(p.type) || SIMPLE_TYPES.has(p.type)) continue;
        if (/Service$/.test(p.type)) continue; // an injected service, not a relation
        relate(p.name, p.type, "many-to-one", "INFERRED");
      }
    }
    return { entities, relations };
  }
}

/** Property types that are values, never another entity. */
const SIMPLE_TYPES = new Set([
  "String", "Integer", "Long", "Short", "Byte", "Double", "Float", "Boolean", "Character", "BigDecimal", "BigInteger",
  "Date", "LocalDate", "LocalDateTime", "LocalTime", "Instant", "OffsetDateTime", "ZonedDateTime", "Timestamp",
  "UUID", "URL", "URI", "Locale", "TimeZone", "Currency", "Object", "Number", "Map", "List", "Set", "Collection",
  "SortedSet", "Blob", "Clob",
]);

/** `name: Target` pairs of a `[a: A, b: B]` map, or `fieldName(Target)`-style entries of `[A, B]` / `A`. */
function pairs(spec: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const map = [...spec.matchAll(/(\w+)\s*:\s*([A-Z]\w*)/g)];
  if (map.length > 0) {
    for (const m of map) out.push([m[1]!, m[2]!]);
    return out;
  }
  // `belongsTo = Author` / `belongsTo = [Author, Publisher]`: no field is named;
  // GORM's back-reference is the decapitalized class.
  for (const m of spec.matchAll(/\b([A-Z]\w*)\b/g)) out.push([m[1]!.charAt(0).toLowerCase() + m[1]!.slice(1), m[1]!]);
  return out;
}

function staticFields(body: string): {
  hasMany: Array<[string, string]>;
  hasOne: Array<[string, string]>;
  belongsTo: Array<[string, string]>;
  transients: Set<string>;
} {
  const read = (name: string): Array<[string, string]> => {
    const m = new RegExp(String.raw`\bstatic\s+${name}\s*=\s*(\[[^\]]*\]|[A-Z]\w*)`).exec(body);
    return m ? pairs(m[1]!) : [];
  };
  const transients = new Set<string>();
  const t = /\bstatic\s+transients\s*=\s*\[([^\]]*)\]/.exec(body);
  if (t) for (const m of t[1]!.matchAll(/['"](\w+)['"]/g)) transients.add(m[1]!);
  return { hasMany: read("hasMany"), hasOne: read("hasOne"), belongsTo: read("belongsTo"), transients };
}
