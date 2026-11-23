import type { ClassInfo, EntityRelation, FileAnalysis, Language, PropertyInfo } from "../../../types/analysis.js";
import { EntityExtractor, type EntityExtractContext, type EntityExtractResult } from "../../entities/base.js";

/**
 * SObjects, read from SFDX source-format metadata (the `*-meta.xml` files the XML plugin hands over):
 *
 *   objects/Club__c/Club__c.object-meta.xml          → the entity (an older single-file object also lists `<fields>`)
 *   objects/Club__c/fields/Rating__c.field-meta.xml  → a column of Club__c
 *   <type>Lookup|MasterDetail</type> + <referenceTo>Club__c</referenceTo> → a many-to-one relation to Club__c
 *
 * A field file states one column and says which object holds it only by its folder, so per file it is a FRAGMENT
 * (a class decorated `sobject-fields`, no entity of its own); `reconcileProject` gathers the fragments onto the
 * object's entity — the object file's, or, when the project keeps only fields (a standard object it adds fields to),
 * the first fragment's. A standard object is an entity only where the project defines it or its fields.
 * Names are the API names as the metadata spells them; data rows naming one in another case are corrected to it.
 */

const METADATA_NS = "soap.sforce.com/2006/04/metadata";
const FRAGMENT = "sobject-fields";
const ORM = "salesforce";

/** Whether a file is SFDX object or field metadata (by name, then by its namespace). */
export function isSalesforceMetadata(relativePath: string, raw: string): boolean {
  return /\.(?:object|field)-meta\.xml$/i.test(relativePath) && raw.includes(METADATA_NS);
}

const tag = (xml: string, name: string): string | null => new RegExp(String.raw`<${name}>\s*([^<]*?)\s*</${name}>`).exec(xml)?.[1]?.trim() || null;

/** The object folder a metadata path sits in: `…/objects/Club__c/fields/X.field-meta.xml` → `Club__c`. */
function objectOfPath(path: string): string | null {
  return /(?:^|\/)objects\/([^/]+)\//.exec(path)?.[1] ?? null;
}

interface FieldDef { name: string; type: string | null; referenceTo: string | null; required: boolean }

function fieldDefOf(xml: string, fallbackName: string | null): FieldDef | null {
  const name = tag(xml, "fullName") ?? fallbackName;
  if (!name) return null;
  const type = tag(xml, "type");
  return { name, type, referenceTo: tag(xml, "referenceTo"), required: tag(xml, "required") === "true" || type === "MasterDetail" };
}

function relationOf(object: string, f: FieldDef): EntityRelation | null {
  if (!f.referenceTo || (f.type !== "Lookup" && f.type !== "MasterDetail" && f.type !== "Hierarchy")) return null;
  return {
    fromEntity: object, fromField: f.name, toEntity: f.referenceTo, cardinality: "many-to-one",
    optional: !f.required, orm: ORM, confidence: "EXTRACTED",
  };
}

export class SalesforceEntityExtractor extends EntityExtractor {
  readonly languages: Language[] = ["apex"];

  extract(ctx: EntityExtractContext): EntityExtractResult {
    const path = ctx.analysis.filePath;
    const xml = ctx.sourceText;
    if (!isSalesforceMetadata(path, xml)) return { entities: [], relations: [] };
    const fileName = /([^/]+)\.(?:object|field)-meta\.xml$/i.exec(path)?.[1] ?? null;
    const relations: EntityRelation[] = [];
    const column = (f: FieldDef): PropertyInfo => ({ ...this.column(f.name, f.type), ...(f.referenceTo ? { references: f.referenceTo } : {}) } as PropertyInfo);

    if (/\.field-meta\.xml$/i.test(path)) {
      const object = objectOfPath(path);
      const field = fieldDefOf(xml, fileName);
      if (!object || !field) return { entities: [], relations: [] };
      const rel = relationOf(object, field);
      if (rel) relations.push(rel);
      const fragment = this.entity({ name: object, orm: ORM, properties: [column(field)], extraDecorators: [FRAGMENT] });
      fragment.decorators = [FRAGMENT];
      return { entities: [fragment], relations };
    }

    const object = fileName ?? objectOfPath(path);
    if (!object) return { entities: [], relations: [] };
    const props: PropertyInfo[] = [{ ...this.column("Id", "Id"), primaryKey: true } as PropertyInfo];
    // An object file of the older format lists its fields inline.
    for (const m of xml.matchAll(/<fields>([\s\S]*?)<\/fields>/g)) {
      const f = fieldDefOf(m[1]!, null);
      if (!f) continue;
      props.push(column(f));
      const rel = relationOf(object, f);
      if (rel) relations.push(rel);
    }
    return { entities: [this.entity({ name: object, orm: ORM, properties: props, line: 1, endLine: xml.split("\n").length })], relations };
  }

  /** Fragments onto their object's entity; data rows' object names to the case the metadata spells. */
  override reconcileProject(analyses: FileAnalysis[]): void {
    const apex = analyses.filter((a) => a.language === "apex");
    const hosts = new Map<string, ClassInfo>();
    const fragments: Array<{ file: FileAnalysis; cls: ClassInfo }> = [];
    for (const file of apex) {
      for (const cls of file.classes) {
        if (cls.decorators.includes(FRAGMENT)) fragments.push({ file, cls });
        else if (cls.decorators.includes("entity") && cls.decorators.includes(ORM) && !hosts.has(cls.name.toLowerCase())) hosts.set(cls.name.toLowerCase(), cls);
      }
    }
    for (const { file, cls } of fragments) {
      let host = hosts.get(cls.name.toLowerCase());
      if (!host) {
        // Fields of an object the project declares no file for: the first fragment becomes its entity.
        cls.decorators = ["entity", ORM];
        cls.properties = [{ ...this.column("Id", "Id"), primaryKey: true } as PropertyInfo, ...cls.properties];
        hosts.set(cls.name.toLowerCase(), cls);
        host = cls;
        continue;
      }
      const have = new Set(host.properties.map((p) => p.name));
      for (const p of cls.properties) if (!have.has(p.name)) { have.add(p.name); host.properties.push(p); }
      file.classes = file.classes.filter((c) => c !== cls);
    }
    if (hosts.size === 0) return;
    for (const file of apex) {
      for (const d of file.dataSources) {
        if (d.kind !== "database" || !d.entity) continue;
        const declared = hosts.get(d.entity.toLowerCase());
        if (declared && declared.name !== d.entity) { d.entity = declared.name; d.target = declared.name; }
      }
    }
  }
}
