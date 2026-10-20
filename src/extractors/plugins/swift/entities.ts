import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Swift persistence models — the local store of an iOS app's screen → data trace:
 *   - SwiftData: `@Model final class Item { var name: String; var tags: [Tag] = [] }`;
 *     a stored property typed as another model is a relation (`[Tag]` one-to-many,
 *     `Owner?` many-to-one), `@Relationship(…)` saying so outright.
 *   - Core Data: an `NSManagedObject` subclass's `@NSManaged var` properties.
 * Computed properties (`var x: T { … }`) and `@Transient` ones are not stored.
 */

const BUILTIN = new Set(["String", "Int", "Int8", "Int16", "Int32", "Int64", "UInt", "Double", "Float", "Bool", "Date", "UUID", "Data", "URL", "Decimal", "Character", "CGFloat", "NSNumber", "NSString", "NSDate", "NSData", "NSSet", "NSOrderedSet", "Any", "AnyObject"]);
const STORED_RE = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:public\s+|private\s+|internal\s+|fileprivate\s+)?(?:@NSManaged\s+)?(?:public\s+|private\s+)?var\s+(\w+)\s*:\s*([^={]+?)\s*(?:=.*)?$/;

export class SwiftEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["swift"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];
    const lines = ctx.lines;
    for (const cls of ctx.analysis.classes) {
      const header = lines[cls.line - 1] ?? "";
      const above = lines.slice(Math.max(0, cls.line - 3), cls.line).join("\n");
      const swiftData = /@Model\b/.test(above);
      const coreData = /:\s*NSManagedObject\b/.test(header) || cls.extends === "NSManagedObject";
      if (!swiftData && !coreData) continue;
      const props: PropertyInfo[] = [];
      // Stored properties are the statements directly in the class body (brace depth 1).
      let depth = 0;
      for (let i = cls.line - 1; i < Math.min(cls.endLine, lines.length); i++) {
        const line = lines[i]!;
        const before = depth;
        depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
        if (before !== 1) continue;
        const m = STORED_RE.exec(line);
        // A computed property opens a body; `@Transient` is not stored; Core Data stores only `@NSManaged`.
        if (!m || depth > before || /@Transient\b/.test(line) || (coreData && !/@NSManaged\b/.test(line))) continue;
        const [, name, rawType] = m;
        const type = rawType!.trim();
        props.push({ ...this.column(name!, type), ...(type.endsWith("?") ? {} : { isRequired: true }) });
        const many = /^\[\s*([A-Z]\w*)\s*\]\??$/.exec(type);
        const one = /^([A-Z]\w*)\??$/.exec(type);
        const target = many?.[1] ?? one?.[1];
        if (target && !BUILTIN.has(target)) {
          relations.push({ fromEntity: cls.name, fromField: name!, toEntity: target, cardinality: many ? "one-to-many" : "many-to-one", orm: swiftData ? "swiftdata" : "coredata", confidence: /@Relationship\b/.test(line) ? "EXTRACTED" : "INFERRED" });
        }
      }
      entities.push(this.entity({ name: cls.name, orm: swiftData ? "swiftdata" : "coredata", properties: props, line: cls.line, endLine: cls.endLine }));
    }
    return { entities, relations };
  }
}
