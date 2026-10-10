import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import type { ClassInfo, EntityRelation, Language, PropertyInfo } from "../../../types/analysis.js";

/**
 * Dart ORM entities — the local database half of a Flutter app's screen → DB
 * trace:
 *   - Drift:  `class RemoteAssetEntity extends Table { TextColumn get id => text()(); … }`;
 *             a column's `.references(UserEntity, #id)` is a many-to-one.
 *   - Isar:   `@collection class Asset { Id id = …; late String name; final owner = IsarLink<User>(); }`;
 *             `IsarLink<X>` is many-to-one, `IsarLinks<X>` one-to-many.
 *   - Floor:  `@entity class Person { @primaryKey final int id; … }` with
 *             `@ForeignKey(childColumns: ['ownerId'], parentColumns: ['id'], entity: User)`.
 *   - Hive:   `@HiveType(typeId: 1) class Settings { @HiveField(0) late String theme; }`.
 * Source-text based over each class's line range; never throws.
 */
export class DartEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["dart"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];
    const lines = ctx.lines;
    for (const cls of ctx.analysis.classes) {
      try {
        const decl = lines[cls.line - 1] ?? "";
        const above = lines.slice(Math.max(0, cls.line - 4), cls.line - 1).join("\n");
        const body = lines.slice(cls.line, Math.min(cls.endLine, lines.length));
        if (/\bextends\s+Table\b/.test(decl) || cls.extends === "Table") {
          this.drift(cls, body, entities, relations);
        } else if (/@[cC]ollection\b/.test(above)) {
          this.isar(cls, body, entities, relations);
        } else if (/@[eE]ntity\b/.test(above)) {
          this.floor(cls, body, above, entities, relations);
        } else if (/@HiveType\b/.test(above)) {
          this.fields(cls, body, "hive", entities, /@HiveField\b/);
        }
      } catch {
        // Skip a class that cannot be read; keep the rest.
      }
    }
    return { entities, relations };
  }

  private drift(cls: ClassInfo, body: string[], entities: ClassInfo[], relations: EntityRelation[]): void {
    const props: PropertyInfo[] = [];
    for (let i = 0; i < body.length; i++) {
      const m = /^\s*(\w+)Column(?:<[^>]*>)?\s+get\s+(\w+)\s*=>/.exec(body[i]!);
      if (!m) continue;
      props.push(this.column(m[2]!, m[1]!.toLowerCase()));
      const ref = /\.references\(\s*(\w+)\s*,\s*#(\w+)/.exec(body[i]!);
      if (ref) {
        relations.push({ fromEntity: cls.name, fromField: m[2]!, toEntity: ref[1]!, cardinality: "many-to-one", foreignKey: m[2]!, orm: "drift", confidence: "EXTRACTED" });
      }
    }
    entities.push(this.entity({ name: cls.name, orm: "drift", properties: props, implementsList: this.targets(relations, cls.name), line: cls.line, endLine: cls.endLine }));
  }

  private isar(cls: ClassInfo, body: string[], entities: ClassInfo[], relations: EntityRelation[]): void {
    const props: PropertyInfo[] = [];
    for (const line of body) {
      const link = /\b(?:final|late|var)?\s*(\w+)\s*=\s*IsarLinks?<(\w+)>\(\)|\bIsarLinks?<(\w+)>\s+(\w+)\s*[;=]/.exec(line);
      if (link) {
        const field = link[1] ?? link[4]!;
        const target = link[2] ?? link[3]!;
        relations.push({ fromEntity: cls.name, fromField: field, toEntity: target, cardinality: /IsarLinks</.test(line) ? "one-to-many" : "many-to-one", orm: "isar", confidence: "EXTRACTED" });
        continue;
      }
      const f = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:late\s+|final\s+)?([A-Z]\w*(?:<[^>]*>)?\??|int|double|bool|num)\s+(\w+)\s*(?:=|;)/.exec(line);
      if (!f) continue;
      props.push(this.column(f[2]!, f[1]!.replace(/\?$/, "")));
    }
    entities.push(this.entity({ name: cls.name, orm: "isar", properties: props, implementsList: this.targets(relations, cls.name), line: cls.line, endLine: cls.endLine }));
  }

  private floor(cls: ClassInfo, body: string[], above: string, entities: ClassInfo[], relations: EntityRelation[]): void {
    const annotations = above + "\n" + body.join("\n");
    for (const m of annotations.matchAll(/@ForeignKey\(([^)]*)\)/g)) {
      const child = /childColumns\s*:\s*\[\s*['"](\w+)['"]/.exec(m[1]!)?.[1];
      const target = /entity\s*:\s*(\w+)/.exec(m[1]!)?.[1];
      if (child && target) relations.push({ fromEntity: cls.name, fromField: child, toEntity: target, cardinality: "many-to-one", foreignKey: child, orm: "floor", confidence: "EXTRACTED" });
    }
    this.fields(cls, body, "floor", entities, null, this.targets(relations, cls.name));
  }

  /** Plain Dart fields as columns (`late String name;`, `final int id;`, `@HiveField(0) String? theme;`). */
  private fields(cls: ClassInfo, body: string[], orm: string, entities: ClassInfo[], marker: RegExp | null, implementsList: string[] = []): void {
    const props: PropertyInfo[] = [];
    for (let i = 0; i < body.length; i++) {
      const line = body[i]!;
      if (marker && !marker.test(line) && !marker.test(body[i - 1] ?? "")) continue;
      const f = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:late\s+|final\s+)?([A-Z]\w*(?:<[^>]*>)?\??|int|double|bool|num)\s+(\w+)\s*(?:=|;)/.exec(line);
      if (!f) continue;
      props.push(this.column(f[2]!, f[1]!.replace(/\?$/, "")));
    }
    entities.push(this.entity({ name: cls.name, orm, properties: props, implementsList, line: cls.line, endLine: cls.endLine }));
  }

  private targets(relations: EntityRelation[], from: string): string[] {
    return [...new Set(relations.filter((r) => r.fromEntity === from).map((r) => r.toEntity))];
  }
}
