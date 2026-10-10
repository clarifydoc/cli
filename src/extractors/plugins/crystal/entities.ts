import { pluralize, singularize } from "../shared/inflection.js";
import type { CallInfo, ClassInfo, DataSourceInfo, EntityRelation, FileAnalysis, FunctionInfo, Language, PropertyInfo } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";
import { isInstanceWrite, modelAccess } from "./data-sources.js";

const CRYSTAL_ORMS = new Set(["granite", "jennifer", "avram", "clear"]);

/**
 * Crystal ORM models:
 *
 *  - Granite: `class Post < Granite::Base` — `table posts`, `column title : String`,
 *    `belongs_to user : User` / `belongs_to :user`, `has_many comments : Comment`;
 *  - Avram (Lucky): `class User < BaseModel` with a `table do … end` (or
 *    `table :users do`) block — `column email : String`, `has_many posts : Post`,
 *    `belongs_to company : Company`; the table is the plural of the class;
 *  - Jennifer: `class User < Jennifer::Model::Base` — `table_name "users"`,
 *    `mapping(id: Primary32, name: String)`, `has_many :posts, Post`;
 *  - Clear: `include Clear::Model` — `self.table = "users"`, `column id : Int64, primary: true`.
 */
export class CrystalEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["crystal"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const entities: ClassInfo[] = [];
    const relations: EntityRelation[] = [];
    for (const cls of ctx.analysis.classes) {
      if (cls.kind === "enum" || cls.kind === "interface") continue;
      const body = this.bodyOf(ctx, cls).join("\n");
      const header = ctx.lines[cls.line - 1] ?? "";
      const orm = /<\s*Granite::Base\b/.test(header) ? "granite"
        : /<\s*Jennifer::Model::Base\b/.test(header) ? "jennifer"
        : /\binclude\s+Clear::Model\b/.test(body) ? "clear"
        : /<\s*(?:Avram::Model|BaseModel)\b/.test(header) || /^\s*table\s*(?::\w+\s*)?do\b/m.test(body) ? "avram"
        : null;
      if (!orm) continue;
      const name = cls.name.split("::").pop()!;
      const columns: PropertyInfo[] = [];
      const seen = new Set<string>();
      const column = (field: string, type: string | null) => {
        if (!seen.has(field)) { seen.add(field); columns.push(this.column(field, type?.replace(/\s*\?$/, "").trim() || null)); }
      };
      for (const m of body.matchAll(/^\s*(?:column|primary_key|field)\s+:?([a-z_]\w*)\s*(?::\s*|,\s*)([A-Z][\w:?()]*)?/gm)) column(m[1]!, m[2] ?? null);
      // Jennifer: `mapping(id: Primary32, name: String, age: Int32?)`, possibly over several lines.
      const mapping = /\bmapping\s*\(([\s\S]*?)\)\s*$/m.exec(body)?.[1];
      if (mapping) for (const m of mapping.matchAll(/([a-z_]\w*)\s*:\s*\{?\s*(?:type:\s*)?([A-Z][\w?]*)/g)) column(m[1]!, m[2]!);

      const table = /^\s*table\s+:?"?(?!do\b)([a-z_]\w*)"?/m.exec(body)?.[1]
        ?? /^\s*table_name\s+"([^"]+)"/m.exec(body)?.[1]
        ?? /self\.table\s*=\s*"([^"]+)"/.exec(body)?.[1]
        ?? (orm === "avram" ? pluralize(underscore(name)) : undefined);
      entities.push(this.entity({
        name, orm, properties: columns, extends: cls.extends, line: cls.line, endLine: cls.endLine,
        extraDecorators: table ? [`table:${table}`] : undefined,
      }));

      // `has_many posts : Post` / `has_many :posts, Post` / `has_many :posts, class_name: Post` / `belongs_to :user`.
      const re = /^\s*(belongs_to|has_many|has_one|has_and_belongs_to_many)\s+:?([a-z_]\w*)\s*(?::\s*([A-Z][\w:]*)|,\s*(?:class_name:\s*|klass:\s*)?"?([A-Z][\w:]*))?/gm;
      for (const m of body.matchAll(re)) {
        const field = m[2]!;
        const explicit = (m[3] ?? m[4])?.split("::").pop();
        const kind = m[1]!;
        const target = explicit ?? camelize(kind === "has_many" || kind === "has_and_belongs_to_many" ? singularize(field) : field);
        const cardinality: EntityRelation["cardinality"] = kind === "belongs_to" ? "many-to-one" : kind === "has_one" ? "one-to-one" : kind === "has_many" ? "one-to-many" : "many-to-many";
        relations.push({ fromEntity: name, fromField: field, toEntity: target, cardinality, orm, confidence: explicit ? "EXTRACTED" : "INFERRED" });
      }
    }
    return { entities, relations };
  }

  /**
   * Project-level pass: a call is a query when its receiver is a MODEL, and
   * the models are declared across the project — `Post.find(id)` in a Kemal
   * route, `post.save` on a local bound to `Post.new`. Per file, `Post` could
   * be any class (`Address.create` is a factory), so these accesses are only
   * joined here, against the entities every Crystal file declared.
   */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const crystal = analyses.filter((a) => a.language === "crystal");
    const models = new Set<string>();
    for (const a of crystal) {
      for (const cls of a.classes) if (cls.decorators.includes("entity") && cls.decorators.some((d) => CRYSTAL_ORMS.has(d))) models.add(cls.name.split("::").pop()!);
    }
    if (models.size === 0) return;
    for (const a of crystal) {
      const seen = new Set(a.dataSources.map((d) => `${d.line}\0${d.name}`));
      const added: DataSourceInfo[] = [];
      const add = (entity: string, method: string, access: "read" | "write", line: number) => {
        const name = `${entity}.${method}`;
        if (seen.has(`${line}\0${name}`)) return;
        seen.add(`${line}\0${name}`);
        added.push({ kind: "database", name, target: entity, entity, access, calls: [], line });
      };
      const visit = (calls: CallInfo[], fn?: FunctionInfo) => {
        for (const call of calls) {
          const dot = call.name.lastIndexOf(".");
          if (dot <= 0) continue;
          const head = call.name.slice(0, dot);
          const method = call.name.slice(dot + 1);
          const cls = head.split("::").pop()!;
          if (/^[A-Z]/.test(cls)) {
            const access = models.has(cls) ? modelAccess(method) : null;
            if (access) add(cls, method, access, call.line);
          } else if (!head.includes(".") && isInstanceWrite(method)) {
            const declared = call.receiverType ?? fn?.localTypes?.find((l) => l.name === head)?.type ?? fn?.params.find((p) => p.name === head)?.type;
            const type = declared?.replace(/\?$/, "").split("::").pop();
            if (type && models.has(type)) add(type, method, "write", call.line);
          }
        }
      };
      for (const fn of a.functions) visit(fn.calls, fn);
      for (const cls of a.classes) for (const m of cls.methods) visit(m.calls, m);
      for (const route of a.routes) visit(route.calls);
      if (added.length > 0) a.dataSources = [...a.dataSources, ...added].sort((x, y) => x.line - y.line);
    }
  }
}

function underscore(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").toLowerCase();
}
function camelize(word: string): string {
  return word.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
}
