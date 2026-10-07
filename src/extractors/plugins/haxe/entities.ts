import type { ClassInfo, EntityRelation, Language } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";

/** record-macros field types that are values: `SId`, `SString<32>`, `SNull<SInt>`, `SDateTime`. */
const VALUE_TYPE = /^(?:Null<)?S[A-Z]\w*|^(?:Int|Float|Bool|String|Date)\b/;

/**
 * record-macros (SPOD) models: `class User extends sys.db.Object` — its
 * fields are columns, `@:table("users")` names the table, a field marked
 * `@:relation(uid)` and typed by another class is a many-to-one relation.
 */
export class HaxeEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["haxe"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];
    for (const cls of ctx.analysis.classes) {
      const header = ctx.lines[cls.line - 1] ?? "";
      if (!/\bextends\s+(?:sys\.db\.)?Object\b/.test(header) || !/sys\.db/.test(ctx.sourceText)) continue;
      const above = ctx.lines.slice(Math.max(0, cls.line - 4), cls.line - 1).join("\n");
      const table = /@:table\(\s*["']([^"']+)["']/.exec(above + header)?.[1];
      const columns = cls.properties.filter((p) => !p.isStatic && !(p.decorators ?? []).some((d) => /^:?skip/.test(d)));
      entities.push(this.entity({
        name: cls.name, orm: "record-macros", extends: null, line: cls.line, endLine: cls.endLine,
        properties: columns.filter((p) => !(p.decorators ?? []).some((d) => /^:?relation/.test(d))).map((p) => this.column(p.name, p.type)),
        extraDecorators: table ? [`table:${table}`] : undefined,
      }));
      for (const p of columns) {
        if (!(p.decorators ?? []).some((d) => /^:?relation/.test(d)) || !p.type || VALUE_TYPE.test(p.type)) continue;
        relations.push({ fromEntity: cls.name, fromField: p.name, toEntity: p.type.replace(/^Null<(.*)>$/, "$1"), cardinality: "many-to-one", orm: "record-macros", confidence: "EXTRACTED" });
      }
    }
    return { entities, relations };
  }
}
